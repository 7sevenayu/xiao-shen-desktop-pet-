# 🐟 DeepSeek 桌宠 · 小深

一个可爱又动态的 Windows 桌面宠物，基于 Electron。它会漂浮、摇摆、呼吸，还会朝你的光标倾斜；能一键启动 DeepSeek，把文件「吃掉」丢进回收站，支持换肤和开机自启。

## ✨ 功能

| 操作 | 效果 |
| --- | --- |
| 🖱️ 左键拖动 | 把桌宠抱到屏幕任意位置（松手轻轻弹一下） |
| 👆 单击 | 戳戳它：果冻式轻微抖动 + 星光 |
| 🖱️ 双击 | 打开 **DeepSeek 网页版**（https://chat.deepseek.com/） |
| 🗑️ 拖文件/文件夹到它身上 | 播放「咀嚼」动画，并把文件**丢进回收站** |
| 🖱️ 右键 | 打开功能菜单 |
| 🎨 右键 → 换肤 | 内置 3 套皮肤（经典蓝/樱花粉/薄荷绿），可**导入 PNG 立绘** |
| 🎬 图集动画皮肤 | 导入 Codex 格式精灵图集（1536×1872）自动获得**真帧动画**（呼吸/跑步/挥手/跳跃/失败…） |
| 🚀 右键 → 开机自启 | 随 Windows 开机自动弹出（默认开启，可关） |
| 🤖 右键 → 启动 dsh | dsh 已运行时直接打开网页；未运行则新开终端启动 |
| 📌 右键 → 置顶 | 切换窗口是否置顶 |
| 🎉 右键 → 来点动作 | 随机来一段小动作 |

闲置时会漂浮摇摆 + 呼吸缩放，偶尔还会伸懒腰或轻轻跳一下（图集皮肤则随机挥手/跳跃）。

## 🚀 运行

双击 `启动桌宠.bat`（或 `start-pet.bat`）即可。首次运行会自动安装 Electron 依赖（需要联网）。

也可以手动运行：

```bash
cd E:\node\desktop-pet
npm install
npm start
```

## 🎨 换肤说明

- 内置皮肤由原立绘实时调色生成（经典蓝 / 樱花粉 / 薄荷绿）。
- 「导入 PNG 立绘」会打开文件选择框，选中的图片会被复制到 `skins\` 目录并立刻切换；建议使用**透明背景 PNG**。
- 导入的图片如果是 **1536×1872 的 Codex 精灵图集**（8列×9行，每帧 192×208），会自动识别为**图集动画皮肤**：待机呼吸、跑步（拖动时）、挥手、跳跃（戳它时）、失败沮丧等真帧动画，皮肤列表里带 🎬 标记。
- 自带两个示例图集皮肤：`示例·Homelander`、`示例·暗夜骑士`（来自 hatch-pet 项目示例，MIT 协议）。
- 选择的皮肤会记录在 `pet-config.json` 中，下次启动自动应用。

## 🐣 生成你自己的动画立绘（hatch-pet）

桌宠已内置完整的 **hatch-pet 图集动画引擎**，配好 API Key 后可用 `E:\node\pet-hatch\生成精灵.bat` 为「小深」生成专属动画立绘（日式动漫插画风，多套真帧动作）：

1. 创建 `E:\node\.env`，内容：`HATCH_PET_PROVIDER=openai`、`HATCH_PET_API_KEY=你的Key`、`HATCH_PET_BASE_URL=https://api.openai.com`、`HATCH_PET_MODEL=gpt-image-2`（需要支持 gpt-image-2 的 OpenAI 兼容端点，全流程约 ¥1.5）。
2. 双击 `E:\node\pet-hatch\生成精灵.bat`：先出预览图供确认，满意后继续全量生成并自动复制到 `desktop-pet\skins\xiao-shen.png`。
3. 重启桌宠 → 换肤 → 选择 `xiao-shen`，即可拥有真帧动画的小深。
4. 角色描述在 `E:\node\pet-hatch\xiao-shen\pet.json` 里，可自行修改。

> 不想用 API？可以用 ChatGPT（GPT-Image-2）手动生成：提示词在 `E:\node\pet-hatch\prompts\`（含完整操作说明），生成后双击 `E:\node\pet-hatch\拼装图集.bat` 本地拼装。

## 🚀 开机自启说明

- 首次运行会自动写入启动项（注册表 `HKCU\...\CurrentVersion\Run` 的 `DeepSeekPet`），之后每次启动自动弹出宠物。
- 右键菜单或托盘菜单可随时开关；关闭后会删除该注册表项。

## 🛠️ 其他说明

- 桌宠常驻**系统托盘**，右键托盘图标可随时「显示桌宠 / 退出」。
- 删除文件走的是系统**回收站**（`shell.trashItem`），不是永久删除，误删可从回收站还原。
- 宠物图来自 `assets\pet.jpg`；程序启动时会在内存里**裁掉底部文字并去除白色背景**，得到透明立绘。
- 诊断日志写在 `pet-log.txt`，排查问题时可以发给开发者。

## 📁 文件结构

```
desktop-pet/
├── main.js          主进程：窗口、托盘、自启、皮肤、启动应用、回收站、拖动
├── preload.js       安全桥接（contextBridge + webUtils）
├── index.html       界面结构
├── style.css        样式与动画
├── renderer.js      动效、交互、去背景、换肤、咀嚼动画
├── assets/pet.jpg   默认宠物立绘
├── skins/           导入的皮肤（自动创建）
├── pet-config.json  配置（当前皮肤 / 开机自启）
├── pet-log.txt      诊断日志
├── 启动桌宠.bat      一键启动脚本
└── package.json
```
