# 用 Agent 制作投稿包

在地图上选中已有建筑或标记新地块，复制页面生成的 **地点资料**。把下面的 Prompt 和地点资料一起发给你的 Agent，可以再附上你有权使用的实景照片、平面图、建模文件或参考链接。

```text
请为「网上南宁地图创意工坊」制作或整理一个建筑模型，交付一个可上传到投稿页的 ZIP。你可以使用我附上的地点资料、照片、图纸和已有模型完成任务。

【确认地点】
从地点资料读取网页分配的目标 ID、显示名称、底图版本、地图 X/Z 坐标、街景观察点及可用的底图参考。沿用已登记目标的坐标。X 向东，Z 向南，Y 表示高度，单位均为米。如果资料缺少必要的坐标、旧建筑轮廓或来源授权，向我指出缺项。用确实能取得的资料配准，近似值注明依据。

【制作模型】
根据我提供的资料制作建筑，或整理已有模型，保留原作细节和作者归属。用米为单位、Y 轴向上。让模型原点对应地图锚点，模型的 Y=0 对应预期地表。只导出目标建筑和替换范围内的构件。导出自包含 GLB 2.0，内嵌所有贴图和缓冲，关闭 Draco 和 KTX2 压缩。

【生成 ZIP 根目录的三个必需文件】
1. model.glb。上限 20 MiB。
2. manifest.json。UTF-8 JSON，字段如下。
   - schemaVersion 填 1。target 填网页分配的目标 ID，version 用三段数字，如 1.0.0，baseRevision 填网页提供的底图版本。修改已发布的模型使用新版本号。
   - placement 对象含 anchor、yaw、scale。anchor 为 [X, Z, 地表高程偏移]，偏移范围为 ±30 米，0 表示跟随地表。yaw 为绕 Y 轴的角度，范围为 ±180°，+90° 会把模型 +Z 转向地图东侧。scale 为 0.1 到 10 的统一倍率，模型已经按实际尺寸建好时用 1。
   - scope 为拟隐藏的旧建筑多边形列表，包含 1 到 32 个多边形。每个多边形由锚点 500 米内的 3 到 32 个 [X, Z] 顶点组成，自动闭合。沿旧建筑边界绘制，避免顶点重复或边相交。
   - asset 对象含 file、bytes、sha256。file 固定为 "model.glb"。bytes 和 sha256 从最终导出的文件计算。
   - source 对象含 author。有版本库时填 repository 和 40 位 commit。一般建模文件填 kind（"original" 或 "adapted"）和 description（作品来源说明）。
3. submission.json。UTF-8 JSON，schemaVersion 填 1。place 对象含 name、approachAt（有街景覆盖的观察点 [X, Z]）、height（落位后的模型高度，单位为米，可加 description）。rights 对象含 basis（"original"、"permission" 或 "license"）和 statement（实际权利来源及授权范围）。

【可选审核材料】
     evidence/real-world/   有来源可核对的实景照片
     evidence/model/        从实际 GLB 渲染的独立模型图
     evidence/in-map/       候选模型加载到地图后截取的验证图
     changes.md             旧模型范围、实际新增或修改、配准依据和已知偏差
三类图片分别放在对应文件夹，支持 PNG、JPG、JPEG。可附任意张，所有图片解压后的文件大小合计上限为 24 MiB。每类至少一张可读图得 1 分，改动说明另计 1 分。按实际取得的材料提交。只有实际导入对应版本后才能把截图放进 evidence/in-map/。

【检查并交付】
三个必需文件直接放在 ZIP 根目录。ZIP 本身及解压后的内容均不得超过 48 MiB。如果我提供了网页的详细协议或校验工具，按它们检查并修正。

可以从 GitHub 拉取与工坊兼容的底图查看器。若你的环境已有该仓库的访问权限和 Git、Python，可以运行以下命令，并把 /path/to/submission.zip 换成实际 ZIP 的绝对路径。图片附件的验证需要 Pillow。

    git clone https://github.com/ziyan2006/nnol-map-workshop.git
    cd nnol-map-workshop
    python -m pip install Pillow
    python submission.py "/path/to/submission.zip"
    python serve.py --port 8789 --submission "/path/to/submission.zip"

打开服务输出的三维或街景链接，通过「对照底图建筑」切换候选效果，核对比例、朝向、落地和旧建筑遮罩。按需截图放入 evidence/in-map/，重新打包并校验。若需单独看底图，运行 python serve.py 后打开 http://127.0.0.1:8788/?replacements=off。仓库需要授权访问时，继续完成可执行的模型和打包步骤，并如实记录预览状态。

最后交付 ZIP，说明已完成的校验和预览、附上的审核材料，以及还需人工核对的近似配准处。我会把 ZIP 上传到投稿页。
```
