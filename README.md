# 道渊批量立绘

为《道渊》角色批量制作同一主题的立绘。网页和 Codex 共用本地角色库、主题库和任务队列。每个角色一项任务，可以预览提示词、查看成图和单独重跑。

## 在 Codex 中使用

1. 克隆或下载仓库，在 Codex 中把仓库根目录设为工作区。需要 Node.js 22 或更新版本。
2. 把下面这句话发给 Codex，替换成你的路径与名单。

> 从我的 SillyTavern 世界书目录「实际路径」导入道渊本体和创意工坊。用魔法学院主题跑林若悠、宫银叶和慕欣心，林若悠设为学生会长。把成图存到这次批次。

也可以直接说「把‘雨夜巡城’做成新主题，参考工坊现有提示词，写好后保存」。Codex 会参考已导入的模板并把新主题加到同一套主题库。若指定生图，Codex 可用其会话中的图像工具逐人生成，也可使用你配置的兼容生图服务。

首次导入需要两份 JSON。它们通常位于酒馆的 `data/<用户>/worlds`，文件名类似 `《道渊》v5.5.4.json` 和 `DaoYuan Workshop · ….json`。也可以在酒馆世界书界面分别导出。多个角色卡共用同一酒馆时，请选择与《道渊》关联的工坊文件。

## 在浏览器中使用

Windows 上双击 [启动道渊批量立绘.cmd](启动道渊批量立绘.cmd)，浏览器会自动打开工作台。关闭启动窗口即可停止由它启动的服务。

也可以在仓库根目录运行下面的命令，打开 [本地工作台](http://127.0.0.1:8765)。

~~~sh
node portrait.mjs serve
~~~

首次打开先导入两份世界书，再点「同步状态栏立绘」。选择主题、勾选角色或粘贴名单，可选魔法学院身份及本批附加要求。预览后创建批次，点击「复制给 Codex」，把指令粘贴到以此仓库为工作区的 Codex 聊天。已配置生图服务时，网页可直接启动生成。

## 参考图

工具同步 [道渊状态栏立绘索引](https://raw.githubusercontent.com/YttriumCarbide/Daoyuan/main/images.json)，按人物名匹配，能唯一对应的别名也可匹配。整批默认用「常态立绘」，每个角色可以独立选择心动、魔法学院、JK 等已有类型。「预览」或创建批次时会下载并缓存所选图片。同一角色同一类型有多张图时，使用索引里第一张可下载的图。

在角色行展开「添加参考图」，可粘贴公开的 HTTPS 图片直链或上传 PNG、JPEG、WebP。工具会保存为该角色的「自定义参考图」，然后为当前批次选中它。常态缺图时会用该角色已有的自定义图；其他类型缺图时会标出。需要参考图的主题必须补齐才能创建批次。

~~~sh
node portrait.mjs portraits sync
node portrait.mjs reference "林若悠" --type "常态立绘"
node portrait.mjs reference "林若悠" --url "https://example.com/portrait.png"
node portrait.mjs queue --theme "魔法学院" --role "林若悠、宫银叶" --ref-type "常态立绘" --role-ref "林若悠=心动立绘"
~~~

在「批次与成图」查看每人的进度并下载图片，也可以手工导入别处生成的成图。每个批次会保存创建时的提示词和参考图。

## 命令行

~~~sh
node portrait.mjs import --worlds "/path/to/SillyTavern/data/default-user/worlds"
node portrait.mjs import --world "/path/to/道渊本体.json" --workshop "/path/to/工坊.json"
node portrait.mjs library
node portrait.mjs preview --theme "魔法学院" --role "林若悠、宫银叶" --identity "林若悠=學生會長"
node portrait.mjs queue --theme "魔法学院" --role "林若悠、宫银叶"
node portrait.mjs show "<批次ID>"
node portrait.mjs complete "<批次ID>" "林若悠" --image "/path/to/立绘.png"
node portrait.mjs theme add --name "雨夜巡城" --file "/path/to/雨夜巡城.md"
~~~

主题 Markdown 支持 `{{角色名}}`、`{{角色设定}}`、`{{世界观}}`、`{{主题身份}}` 和 `{{补充要求}}`。模板没有写角色设定或世界观占位符时，工具会另行附上相应内容。`theme add` 会保存同名自定义主题的新版。

## 可选生图服务

要让网页或 CLI 直接运行批次，在启动终端设置这些环境变量。

| 变量 | 内容 |
| --- | --- |
| `PORTRAIT_IMAGE_BASE_URL` | 服务基础地址，包含服务要求的版本路径，例如 `https://你的服务/v1` |
| `PORTRAIT_IMAGE_MODEL` | 服务里的生图模型名 |
| `PORTRAIT_IMAGE_API_KEY` | 服务所需的密钥 |
| `PORTRAIT_IMAGE_SIZE` | 可选。由所用服务支持的尺寸，如 `1024x1536` |

服务须支持兼容的 `POST /images/generations`。带参考图的任务还需要支持 `POST /images/edits` 的 multipart 图片上传。工具把该任务的提示词和可用参考图发给配置的服务，并保存返回的图片。环境变量在启动服务时读取。

~~~sh
node portrait.mjs run "<批次ID>"
node portrait.mjs run "<批次ID>" --role "林若悠"
~~~

运行整批会处理待生成和失败项。`--role` 可以只处理指定角色，也可重复传入。已完成的任务保留原成图。

## 演示与本地数据

~~~sh
node portrait.mjs import --world examples/world.json --workshop examples/workshop.json
node portrait.mjs queue --theme "雨城试样" --role "照灯、归鹭"
node --test
~~~

演示使用虚构的角色和模板。导入会替换当前工作区已导入的角色与工坊主题。自定义主题和已建批次保留。实际数据保存在已被 Git 忽略的 `.portrait/` 下，包括角色设定、模板、参考图、批次与成图。要使用独立数据目录，可以设置 `PORTRAIT_HOME`。

如果生成进程被强制结束，个别任务可能残留 `running.lock`。确认该批次原进程已经退出后，删除任务目录中的该锁文件即可重跑。任务路径可用 `node portrait.mjs show "<批次ID>"` 查询。
