# Face Window Tracker

这是一个用普通电脑摄像头驱动三维“虚拟窗口”的实验项目。

摄像头只负责判断观看者的双眼位于屏幕的什么位置，不识别人是谁，也不保存人脸照片。网页根据观看位置实时重算透视投影：人向左移动时能看到更多物体右侧，人抬高时能看到更多物体顶部。屏幕边框始终不动，变化的是屏幕后方的观察视角。

仓库里已经包含两部分：

- Python 人脸位置服务：读取摄像头，检测人脸和双眼，输出经过平滑的位置数据。
- Three.js 展示箱：订阅位置数据，使用离轴投影渲染固定在屏幕后方的三维场景。

## 架构

项目没有把摄像头、视觉模型和三维渲染塞进同一个进程。运行时由两个独立进程组成：Python 服务独占摄像头并持续发布位置，浏览器只负责订阅数据和渲染。两边通过版本化 JSON 协议连接，后续替换视觉模型或渲染引擎时不必一起重写。

三维坐标系、离轴投影公式、物理模式映射、全屏比例约束、测试覆盖和已知标定边界，见 [3D 渲染技术说明](docs/3d-rendering-technical-notes.md)。需要快速了解展示层时优先阅读该文档，无需通读全部源码。

| 层 | 位置 | 主要职责 |
|---|---|---|
| 采集层 | `service.py` | 管理摄像头、读取画面、处理断流和自动重连 |
| 视觉层 | `tracker.py` | 运行 BlazeFace，提取人脸框和双眼关键点 |
| 几何层 | `geometry.py` | 根据相机模型把二维眼位换算为三维观看位置 |
| 稳定层 | `filtering.py` | 使用 One Euro Filter 降低位置抖动 |
| 接口层 | `api.py` | 通过 REST 暴露状态，通过 WebSocket 推送实时结果 |
| 展示层 | `display-case.tsx` | 校准中心、映射坐标、计算离轴投影并渲染场景 |

### 数据流

数据从摄像头到画面的路径如下：

```text
电脑摄像头
  → OpenCV 读取画面
  → MediaPipe BlazeFace 检测人脸与双眼关键点
  → 根据眼间距估算观看者的 x / y / z 位置
  → One Euro Filter 抑制抖动
  → FastAPI WebSocket 推送位置
  → Three.js 离轴投影
  → 固定屏幕边框内的视角变化
```

### 人脸检测

检测后端可插拔，默认使用 OpenCV YuNet + Facemark LBF，详细介绍见下方“使用 OpenCV YuNet + Facemark 后端”。它依赖更少、能在本地 CPU 上跑，并在 Facemark 可用时提供 68 个关键点。

`FACE_TRACKER_BACKEND=detector` 可以切回 MediaPipe 的 BlazeFace Short Range Face Detector：它返回人脸框和六个关键点，本项目只取左右眼关键点来计算眼睛中心和眼间距。

这里没有把 MediaPipe Face Landmarker 当作必需品。展示箱不需要 478 个面部关键点、表情系数或身份特征，双眼位置已经足够，而且在同一台机器上更容易维持较高帧率；需要时可显式选择 `landmarker`。

服务固定选择一张主要人脸。检测不到人脸时会发送 `tracking: false`，前端稍后把视角平滑复位。摄像头短暂断流时，服务会释放设备并自动重连。

### 三维位置估算

双眼中点决定左右和上下位置，图像中的眼间距用于估算人与摄像头的距离。当前采用针孔相机模型：

```text
z = fx × IPD / eyeDistancePixels
x = (eyeCenterX - cx) × z / fx
y = -(eyeCenterY - cy) × z / fy
```

其中：

- `fx`、`fy` 是根据摄像头水平视场角估算的焦距；
- `cx`、`cy` 是图像中心；
- `IPD` 是假设的真实瞳距，默认 63 毫米；
- `eyeDistancePixels` 是两眼在画面中的像素距离。

这套方法能稳定判断相对移动，但目前还不是测量级定位。默认参数假设摄像头水平视场角为 70°，不同摄像头、不同瞳距都会带来距离比例误差。接口中的 `calibrated: false` 就是在明确标记这一点。

### 平滑处理

摄像头关键点会有小幅抖动。如果把原始坐标直接交给相机，三维场景会一直轻微晃动。后端分别对 `x`、`y`、`z` 使用 One Euro Filter：静止时加强平滑，快速移动时提高响应速度。

前端没有再使用固定帧数插值，而是按实际渲染时间计算插值比例。显示器刷新率变化或者识别帧率短时波动时，视角运动速度不会跟着改变。

### 离轴投影

展示箱没有旋转物体来假装视角变化，而是移动虚拟观察点并重算相机视锥。

箱口所在平面被视为真实屏幕平面。根据眼睛相对屏幕的位置，前端每帧计算投影矩阵的 `left`、`right`、`top` 和 `bottom`。因此：

- 屏幕四边与展示箱前框始终重合；
- 人移动时，前框保持固定；
- 箱内墙面、地面和展品产生不同程度的视差；
- 展品本身不转动，看到的是它在不同观察位置下的侧面。

前置摄像头的图像横坐标与观看者面对屏幕时的物理左右相反，前端已经对水平方向做了翻转。

## 运行环境

- macOS、Windows 或 Linux
- 可由 OpenCV 访问的摄像头
- Python 3.12
- [uv](https://docs.astral.sh/uv/)
- Node.js 22.13 或更高版本
- npm

macOS 第一次启动摄像头时，需要允许终端或 Codex 使用摄像头。

## 启动项目

### Windows 一键启动（依赖已安装）

使用名为 `virtual-window-tracker` 的 Conda 环境（Python 3.12），并安装好后端依赖和 `web/node_modules` 后，双击根目录的 `start.cmd`，或在 PowerShell 中运行：

```powershell
.\start.cmd
```

脚本会自动使用 Conda 环境、启动后端与网页，并打开 <http://127.0.0.1:3000/>。默认请求 640 × 480 摄像头画面，并启用前端文件轮询监听。已有的 `FACE_*` 环境变量会保留。

在启动窗口按 Enter 或 Ctrl+C 会停止两个服务。端口被占用时脚本会提示，不会终止已有进程。使用 `.\start.cmd --no-browser` 可跳过自动打开浏览器。

### 手动安装与启动

先安装 Python 依赖：

```bash
uv sync --extra dev
```

首次运行会下载检测模型到 `models/`：默认的 YuNet 检测器约 230 KB（opencv_zoo 官方源）。选择 `detector` 或 `landmarker` 后端时，会改为从 MediaPipe 官方地址下载对应的 BlazeFace / Face Landmarker 模型。

### 1. 启动人脸位置服务

推荐先使用 640 × 480。对于这项任务，更高的摄像头分辨率通常不会明显提高位置精度，却会增加图像传输和转换开销。

```bash
FACE_CAMERA_WIDTH=640 FACE_CAMERA_HEIGHT=480 uv run face-tracker serve
```

服务默认监听 `127.0.0.1:8765`。

如果只想检查摄像头和检测结果，可以运行带标记的预览窗口：

```bash
FACE_CAMERA_WIDTH=640 FACE_CAMERA_HEIGHT=480 uv run face-tracker preview
```

在预览窗口中按 `Q` 或 `Esc` 退出。

### 2. 启动三维展示箱

打开另一个终端：

```bash
cd web
npm install
npm run dev
```

然后访问 <http://localhost:3000/>。

页面第一次检测到人脸时，会把当前位置记录为观看中心。右下角按钮可显示性能信息、切换人脸/鼠标控制、重新校准中心、打开设置和进入全屏。

页面现在分为“模型展示”和“窗户模式”两套设置。模型展示继续使用原来的展品/展示箱逻辑；窗户模式把上传的 GLB 作为固定世界场景，窗口是独立的浮空投影视口。切换到窗户模式后，可点击左上角“设置窗户”进入飞行布置模式。使用 W/S 前后、A/D 左右、Q/E 上下移动，方向键调整朝向，Shift 加速，Enter 确认，Esc 取消。确认后的浮空窗口也可在“显示设置 → 窗户模式设置”中编辑位置、旋转、宽高和统一缩放。

两个服务都可以用 `Ctrl+C` 停止。

## 本地接口

| 地址 | 用途 |
|---|---|
| `GET http://127.0.0.1:8765/api/v1/status` | 摄像头服务状态与错误信息 |
| `GET http://127.0.0.1:8765/api/v1/tracking/latest` | 最近一次追踪结果 |
| `WS ws://127.0.0.1:8765/ws/v1/tracking` | 实时位置数据 |
| `http://127.0.0.1:8765/docs` | FastAPI 生成的接口文档 |

WebSocket 只在产生新结果时发送数据，`sequence` 可用于判断是否收到重复帧。

### 数据示例

```json
{
  "protocol_version": "1.0",
  "type": "face_tracking",
  "sequence": 317,
  "captured_at_unix_ms": 1788175503820,
  "frame": {
    "width": 640,
    "height": 480,
    "fps": 24.15
  },
  "tracking": true,
  "face": {
    "bbox": {
      "pixel": { "x": 341, "y": 100, "width": 203, "height": 203 },
      "normalized": {
        "x": 0.532813,
        "y": 0.208333,
        "width": 0.317188,
        "height": 0.422917
      }
    },
    "eyes": {
      "left": {
        "pixel": { "x": 513.469, "y": 173.567 },
        "screen_normalized": { "x": 0.60459, "y": 0.276806 }
      },
      "right": {
        "pixel": { "x": 440.199, "y": 166.846 },
        "screen_normalized": { "x": 0.375622, "y": 0.30481 }
      },
      "center": {
        "pixel": { "x": 476.834, "y": 170.206 },
        "screen_normalized": { "x": 0.490106, "y": 0.290808 }
      },
      "distance_pixels": 73.577
    },
    "viewer_position_m": {
      "raw": { "x": 0.134288, "y": 0.05976, "z": 0.391309 },
      "filtered": { "x": 0.135205, "y": 0.059625, "z": 0.392727 },
      "coordinate_system": "x-right_y-up_z-toward-viewer",
      "calibrated": false,
      "method": "assumed-horizontal-fov-and-ipd"
    },
    "head_rotation_deg": null,
    "facial_transformation_matrix": null
  }
}
```

`screen_normalized` 以画面中心为 `(0, 0)`，左下角为 `(-1, -1)`，右上角为 `(1, 1)`。

`viewer_position_m.filtered` 是展示端通常应当使用的位置。坐标系定义为：`x` 向摄像头画面右侧，`y` 向上，`z` 从摄像头指向观看者。

## 配置

所有后端参数都可以用环境变量覆盖。

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `FACE_TRACKER_BACKEND` | `yunet` | 检测后端:`yunet`(OpenCV YuNet + Facemark LBF,默认)/ `detector`(BlazeFace)/ `landmarker`(face_landmarker 68 点) |
| `FACE_CAMERA_SOURCE` | `0` | 摄像头编号,也可以是视频文件绝对路径 |
| `FACE_CAMERA_WIDTH` | `1280` | 请求的摄像头宽度 |
| `FACE_CAMERA_HEIGHT` | `720` | 请求的摄像头高度 |
| `FACE_CAMERA_FPS` | `30` | 请求帧率，最终结果取决于摄像头 |
| `FACE_CAMERA_HFOV_DEG` | `70` | 未标定时使用的水平视场角 |
| `FACE_ASSUMED_IPD_M` | `0.063` | 假设瞳距，单位为米 |
| `FACE_MODEL_PATH` | `models/blaze_face_short_range.tflite` | 模型文件位置 |
| `FACE_MODEL_URL` | MediaPipe 官方地址 | 模型不存在时的下载地址 |
| `FACE_MIN_DETECTION_CONFIDENCE` | `0.6` | 人脸检测置信度阈值 |
| `FACE_FILTER_MIN_CUTOFF` | `1.2` | 静止时的平滑强度 |
| `FACE_FILTER_BETA` | `0.035` | 运动时的跟随速度 |
| `FACE_FILTER_DERIVATIVE_CUTOFF` | `1.0` | 速度估计的平滑强度 |

### 网页展示设置

页面右下角的齿轮按钮会打开**显示设置**。展示箱尺寸、观察投影与追踪映射、模型位置与材质、背景和灯光均可在浏览器中即时调整；这些设置只在当前页面会话内有效，刷新页面会恢复默认值。摄像头、检测器和后端滤波参数仍需通过上述 `FACE_*` 环境变量在启动服务前配置。

模型和观察点使用两个独立的 z：世界坐标中窗户平面固定为 `z=0`，模型的“相对窗口深度（米）”为负表示在窗后，正值表示凸出窗外；观察点 z 是眼睛到窗户的距离，始终为正，决定离轴透视和远近变化。模型 z 不是摄像头返回的 z，也不是“眼睛在屏幕上的 z”。

网页统一使用按实测尺寸的窗口投影。请测量可见画面宽度和校准时眼屏距离；窗口只是投影视口，不限制模型尺寸。单模型、Gaussian 或完整场景都放在同一个窗口场景中，模型可以超出窗口，也可以用正深度凸出窗外。高斯资产不会被自动缩放到窗口内。

若摄像头与屏幕平行但不在屏幕中心，可在网页设置中填写摄像头相对屏幕中心的 X/Y/Z 偏置（米）。当前不处理摄像头倾斜旋转；旋转明显时需要完整外参标定。

对屏幕后方的内容，靠近窗户会看到更大的空间范围；对正深度、凸出窗外的模型，靠近时模型与眼睛距离缩短，会自然变大。两者都由同一个物理投影产生，不需要额外 zoom。

使用第二个摄像头：

```bash
FACE_CAMERA_SOURCE=1 uv run face-tracker preview
```

使用视频文件做可重复测试：

```bash
FACE_CAMERA_SOURCE=/absolute/path/to/video.mp4 uv run face-tracker serve
```

### 使用 OpenCV YuNet + Facemark 后端

本地 CPU 运行、依赖更少的检测链路，也是默认后端。首次使用会从 opencv_zoo 官方源下载 YuNet 检测器（约 230 KB）到 `models/`；Facemark LBF（约 54 MB）是可选升级，缺省时自动降级为 YuNet 自带的关键点。

```bash
uv run face-tracker serve                                  # 默认就是 yunet
FACE_TRACKER_BACKEND=detector uv run face-tracker serve    # 切回 BlazeFace
```

`model` 字段会标记为 `opencv-yunet`。眼睛点优先来自 Facemark LBF 的 68 点模型（`eyes.source = facemark-lbf`）；若 LBF 模型缺失或加载失败，则退回 YuNet 检测器自带的眼睛关键点（`eyes.source = yunet-keypoints`）。两种来源都基于同一套眼中心/眼距几何计算输出 `viewer_position_m`。

相关环境变量：

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `FACE_YUNET_MODEL_PATH` | `models/face_detection_yunet_2023mar.onnx` | YuNet 检测器文件 |
| `FACE_LBF_MODEL_PATH` | `models/lbfmodel.yaml` | Facemark LBF 关键点模型（可选，失败不阻塞） |

## 项目结构

```text
.
├── src/face_tracker/
│   ├── api.py           # REST 与 WebSocket 接口
│   ├── cli.py           # serve / preview 命令
│   ├── config.py        # 环境变量与默认配置
│   ├── filtering.py     # One Euro Filter
│   ├── geometry.py      # 相机模型与三维位置估算
│   ├── service.py       # 摄像头生命周期、断流重连与数据缓存
│   └── tracker.py       # BlazeFace 推理与结果整理
├── tests/               # 后端测试
├── models/              # 首次运行后下载的模型
├── docs/                # 设计、验证和许可说明
│   ├── 3d-rendering-technical-notes.md # 3D 渲染与坐标系快速说明
└── web/
    ├── app/             # 页面入口与全局样式
    ├── components/
    │   ├── display-case.tsx  # 展示箱、WebSocket 和离轴投影
    │   └── ui/button.tsx     # 页面使用的按钮组件
    └── public/          # 网站静态资源
```

Python 与 Three.js 之间只通过版本化 JSON 通信。以后如果换成 Unity、Unreal 或原生 OpenGL，后端不需要跟着重写；同样，替换检测算法时也可以保持 `v1` 协议不变。

## 性能说明

在 Apple M2、640 × 480 输入下，轻量检测器通常可以输出约 20–30 FPS。这个数字不是保证值：全屏 Retina WebGL、其他 Chromium 应用、视频播放和高负载的 `WindowServer` 都可能让帧率明显下降。

当前摄像头读取和模型推理在同一个后端工作线程中完成。这样结构简单，正常负载下够用；下一步如果要进一步降低延迟，可以拆成“持续取帧”和“只处理最新帧”两个阶段。重点是丢弃过期帧，而不是同时运行两个模型实例。

前端渲染循环独立运行，识别帧率低于显示器刷新率时会在相邻位置之间平滑过渡。

## 已知限制

- 只追踪一张主要人脸，没有多人目标锁定。
- 不做身份识别、活体检测、视线追踪或表情分析。
- `z` 依赖假设瞳距和摄像头视场角，尚未进行真实尺度标定。
- 普通单目摄像头无法在遮挡、强逆光或大角度侧脸下保证稳定检测。
- 当前展示端写死连接本机 `8765` 端口，适合本地原型，不适合直接部署到公网。
- 展示箱的屏幕物理尺寸尚未标定，不同显示器上的透视比例会略有差异。

## 测试

后端测试：

```bash
uv run pytest
```

前端检查：

```bash
cd web
npm run lint
npm run build
```

`npm run build` 需要 Node.js 22.13 或更高版本。

GitHub 上的每次 `main` 推送和 Pull Request 都会运行同样的后端测试、前端检查与生产构建，配置位于 `.github/workflows/ci.yml`。

## 后续工作

### 当前交互与跟踪行为

显示设置会立即按最近一次人脸位置或鼠标位置重新计算视角，不需要再次移动。
默认观察距离限制在最小、最大观察距离之间；近平面保持在最近观察距离之前，远平面至少覆盖展示箱后墙。
恢复默认设置会同时复位视角，并在下一次有效人脸数据到达时重新校准中心。

右下角的“性能”按钮可显示渲染帧率、后端报告的追踪帧率和距上次收到数据的时间，默认隐藏。
这里的数据时间是浏览器收到消息后的间隔，不是摄像头到屏幕的端到端延迟。
丢失人脸或停止收到有效位置后，视角按超时设置回到中心；鼠标模式不受此超时影响。

多人出现时，初次选择画面中最大的脸，之后依据位置和大小连续性保持目标，丢失 0.7 秒后才重新选择。
这不是身份识别，两个人靠近或交叉时仍可能换人。
纵深使用比水平、垂直方向更强的平滑，代价是前后移动响应稍慢；转头造成的瞳距投影误差仍需后续校准或姿态估计处理。

### 设备化方向

如果要把原型做成稳定的展示设备，优先级比较高的工作是：

1. 标定摄像头内参、摄像头与屏幕的相对位置以及屏幕物理尺寸；
2. 将摄像头采集与推理解耦，只处理最新画面；
3. 增加位置质量评分、丢失预测和更自然的重新捕获；
4. 用真实 GLB / glTF 展品替换当前程序化示例模型；
5. 建立可重复的精度、延迟和帧率测试流程。
