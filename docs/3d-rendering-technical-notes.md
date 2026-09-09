# 3D 虚拟窗口渲染技术说明

这份文档用于快速了解当前渲染几何、最近一次修正和验证方式，不需要先通读整个仓库。

## 用户目标

网页展示一个“屏幕像镜子/窗口”的固定展示箱：屏幕边框是固定平面，箱体和物体位于屏幕后方。观看者左右、上下或前后移动时，视角变化应来自真实的离轴透视，而不是旋转物体或把箱体整体拖动。

## 当前实现的坐标约定

- Three.js 世界坐标：`x` 向右，`y` 向上，`z=0` 是屏幕/箱口平面。
- 观看者在屏幕前方，眼睛的世界 `z` 为正值。
- 箱体后墙、地面、顶棚、侧墙和模型都在屏幕后方，`z < 0`。
- 模型的 `z` 是模型中心相对屏幕平面的世界坐标，不是观看者的 z，也不是摄像头读数；它使用展示箱场景单位。`z=-2` 表示模型中心在屏幕后方 2 个场景单位。
- 开启“按实测尺寸投影”后，模型面板改用“屏幕后深度（米）”，程序按 `z_world = -depth_m × (case.width / visibleWidthM)` 转换，避免把米和场景单位混用。
- `createDisplayCase()` 在 `web/components/display-case.tsx` 中构造箱体；前框由 CSS 屏幕边框叠加，Three 场景的几何前口是 `z=0`。
- Python 服务输出的观看位置是 camera-space：`x-right, y-up, z-toward-viewer`。当前网页默认假设摄像头坐标轴与屏幕世界轴平行；相机相对屏幕的真实旋转/平移外参尚未接入。

## 离轴投影

核心实现：`web/lib/window-projection.ts` 的 `applyWindowProjection()`。

它使用 Kooima 的 generalized perspective projection：

1. 取固定屏幕平面的左下、右下、左上角 `pa/pb/pc`。
2. 计算屏幕正交基 `vr/right`、`vu/up` 和法线 `vn = vr × vu`。
3. 用观察点 `pe` 计算眼睛到屏幕的法向距离。
4. 根据 `pa-pe`、`pb-pe`、`pc-pe` 在屏幕基上的投影，计算 near plane 的非对称 `left/right/bottom/top`。
5. 设置相机位置和旋转，使相机局部 `-Z` 穿过屏幕；再调用 `Matrix4.makePerspective()`。

参考论文：<https://csc.lsu.edu/~kooima/pdfs/gen-perspective.pdf>

重要约束：

- 屏幕平面保持固定；头部移动只改变观察点和非对称视锥。
- 不要在之后调用普通 `camera.updateProjectionMatrix()`，否则会覆盖离轴偏移。
- 自定义屏幕角必须组成正交矩形；剪切基底会被拒绝，避免产生错误的空间扭曲。
- near plane 太近时实现会沿屏幕法线保护性地推远有效相机位置；这是异常观测保护，不是正常标定路径。

## 物理模式与演示模式

`DisplaySettings.view.physicalMode` 默认是 `false`。

- 演示模式使用 `positionGain/depthGain` 和限制范围，适合没有实测屏幕尺寸时的交互预览，不是米制透视。
- 物理模式调用 `physicalView()`：
  - `unitsPerM = case.width / visibleWidthM`
  - 中性眼位映射到 `z = neutralDistanceM * unitsPerM`
  - `x/y/z` 都按同一个米到场景单位比例映射
  - 位置使用相对中性眼的仿射位移，不能用绝对 z 比例分别猜缩放
- 物体的远近透视由同一个离轴投影自动产生；头部 z 改变的是观察点，模型 z/depthM 改变的是物体相对屏幕的深度，两者不要混用。
- 对于屏幕后方的真实物体，屏幕四角固定时，靠近屏幕会看到更大的空间范围，物体在屏幕中的相对尺寸不一定变大；这是窗口透视的正常结果。若产品目标是“靠近就放大细节”，那是额外的非物理 zoom 交互，不应通过把模型 z 调成正值来实现。
- `visibleWidthM` 必须是实际渲染矩形的物理宽度，不是显示器对角线。
- `neutralDistanceM` 是校准时眼睛到屏幕的距离。

## 全屏与显示比例

`web/app/globals.css` 的 fullscreen 规则使用 `--case-aspect` 做等比例留边。不能让 fullscreen viewport 直接填满任意宽高，否则 CSS 画布比例与投影假定的箱体宽高不一致，会造成视觉拉伸。

## 测试与验证

前端测试：

```bash
cd web
npm test
npm run typecheck
npm run build
```

当前测试覆盖：

- 屏幕四角在不同观察点下仍固定在 NDC 四角；
- 旋转屏幕平面的投影基和四角对齐；
- 剪切屏幕基底被拒绝；
- 固定眼位不产生背景网格漂移；
- 物理映射的中性深度和三轴统一比例；
- 追踪丢失、重连、校准和动态渲染预算。

后端测试：

```bash
.venv/bin/python -m pytest -q
```

## 已知边界

当前最重要的未完成项是 camera-to-screen 外参：摄像头如果相对屏幕有倾斜或偏移，单纯把 camera-space 位置直接当成 screen/world-space 会带来整体几何误差。正确的下一步是测量/标定一个刚体变换 `eye_screen = R * eye_camera + t`，再将其传给投影层；不要靠继续增加任意增益解决。

另外，默认演示模式仍然不是现实尺度。需要评估真实几何时，应开启物理模式、测量渲染矩形宽度和眼屏距离，并重新校准中性位置。

## 当前实现记录

- `web/lib/window-projection.ts`：从轴对齐简化矩阵升级为 generalized off-axis projection，支持固定物理屏幕基。
- `web/lib/window-tracking.ts`：物理模式改为围绕中性眼位的统一尺度仿射映射。
- `web/components/display-case.tsx` / `web/app/globals.css`：fullscreen 保持箱体宽高比。
- `web/tests/window.test.mjs`：增加旋转屏幕、剪切基底和物理映射回归测试。
- `docs/rendering-tracking-review-2026-09-06.md`：补充 Kooima 参考和当前物理映射结论。
