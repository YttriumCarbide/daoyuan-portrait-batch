import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { imageExtension, imageLimit } from './storage.mjs';

const restricted = new BlockList();
for (const [ip, bits] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
    ['224.0.0.0', 3],
]) restricted.addSubnet(ip, bits, 'ipv4');
for (const [ip, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16]]) restricted.addSubnet(ip, bits, 'ipv6');

const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const fakeIp = new BlockList();
fakeIp.addSubnet('198.18.0.0', 15, 'ipv4');

function publicAddress({ address, family }) {
    const type = family === 6 ? 'ipv6' : 'ipv4';
    return (family === 4 || globalV6.check(address, 'ipv6')) && !restricted.check(address, type);
}

export function httpsImageUrl(input) {
    if (typeof input !== 'string' || input.length > 8192) throw new Error('图片 URL 无效。');
    let url;
    try { url = new URL(input); } catch { throw new Error('请输入完整的 HTTPS 图片 URL。'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) {
        throw new Error('图片 URL 需要使用公开的 HTTPS 地址。');
    }
    url.hash = '';
    return url;
}

async function publicLookup(host, signal) {
    const addresses = await lookup(host, { all: true });
    const allowed = addresses.filter(publicAddress);
    if (allowed.length) return allowed;
    if (addresses.some(item => item.family === 4 && fakeIp.check(item.address, 'ipv4'))) {
        // Some local proxies provide a synthetic DNS address for public hosts.
        const query = new URL('https://cloudflare-dns.com/dns-query');
        query.searchParams.set('name', host);
        query.searchParams.set('type', 'A');
        const result = await fetch(query, { headers: { Accept: 'application/dns-json' }, redirect: 'error', signal });
        if (result.ok) {
            const { Answer } = await result.json();
            const resolved = (Answer ?? []).filter(item => item.type === 1 && isIP(item.data) === 4)
                .map(item => ({ address: item.data, family: 4 })).filter(publicAddress);
            if (resolved.length) return resolved;
        }
    }
    throw new Error('图片 URL 不能指向本机或内网。');
}

function requestImage(url, signal) {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const family = isIP(hostname);
    if (family && !publicAddress({ address: hostname, family })) {
        throw new Error('图片 URL 不能指向本机或内网。');
    }
    return new Promise((resolve, reject) => {
        const req = request(url, {
            signal,
            headers: { Accept: 'image/*', 'User-Agent': 'Daoyuan-Portrait-Batch' },
            lookup(host, options, callback) {
                publicLookup(host, signal).then(allowed => {
                    if (options.all) callback(null, allowed);
                    else callback(null, allowed[0].address, allowed[0].family);
                }).catch(callback);
            },
        }, resolve);
        req.on('error', reject);
        req.end();
    });
}

export async function downloadImage(input) {
    let url = httpsImageUrl(input);
    const signal = AbortSignal.timeout(15000);
    for (let redirects = 0; redirects <= 4; redirects++) {
        const response = await requestImage(url, signal);
        const { statusCode, headers } = response;
        if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location) {
            response.destroy();
            url = httpsImageUrl(new URL(headers.location, url).href);
            continue;
        }
        if (statusCode !== 200 || Number(headers['content-length']) > imageLimit) {
            response.destroy();
            if (statusCode !== 200) throw new Error('图片服务器返回 HTTP ' + statusCode + '。');
            throw new Error('图片不能超过 20 MiB。');
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of response) {
            size += chunk.length;
            if (size > imageLimit) throw new Error('图片不能超过 20 MiB。');
            chunks.push(chunk);
        }
        const image = Buffer.concat(chunks);
        imageExtension(image);
        return image;
    }
    throw new Error('图片 URL 重定向次数过多。');
}
