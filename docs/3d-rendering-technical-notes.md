# 3D 虚拟窗口渲染技术说明

这份文档用于快速了解当前渲染几何、最近一次修正和验证方式，不需要先通读整个仓库。

## 用户目标

网页展示一个“屏幕像镜子/窗口”的固定展示箱：屏幕边框是固定平面，箱体和物体位于屏幕后方。观看者左右、上下或前后移动时，视角变化应来自真实的离轴透视，而不是旋转物体或把箱体整体拖动。

## 当前实现的坐标约定

- Three.js 世界坐标：`x` 向右，`y` 向上，`z=0` 是屏幕/窗户平面。
- 观看者在屏幕前方，眼睛的世界 `z` 为正值。
- 箱体、场景和模型都是窗户后面的可选内容；内容可以超出窗口范围，也可以穿过窗口。
- 模型的“相对窗口深度（米）”带符号：负值在窗后，正值向观看者凸出。程序按 `z_world = depth_m × (case.width / visibleWidthM)` 转换，避免把米和场景单位混用。
- `createDisplayCase()` 在 `web/components/display-case.tsx` 中构造箱体；前框由 CSS 屏幕边框叠加，Three 场景的几何前口是 `z=0`。
- 完整场景可用 `web/lib/window-anchor.ts` 的 `WindowAnchor` 声明场景中的窗户中心、方向和真实宽高，再将其三个角传给 `applyWindowProjection()`；窗户是场景投影视口，不是内容容器。
- Python 服务输出的观看位置是 camera-space：`x-right, y-up, z-toward-viewer`。当前网页假设摄像头坐标轴与屏幕世界轴平行。
- 当前已支持“平行摄像头”的平移偏置：在设置中填写摄像头相对屏幕中心的 X/Y/Z（米）。暂不处理摄像头相对屏幕的旋转；若摄像头有明显俯仰、偏航或滚转，仍需后续完整外参标定。

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
- 近平面会在眼睛非常靠近窗口时按当前眼屏距离缩小；不会偷偷移动测得的观察点。若追踪数据落到窗口平面后方，前端应拒绝该样本并保留上一帧有效视角。

## 统一物理窗口模式

- 统一窗口模式调用 `physicalView()`：
  - `unitsPerM = case.width / visibleWidthM`
  - 中性眼位映射到 `z = neutralDistanceM * unitsPerM`
  - `x/y/z` 都按同一个米到场景单位比例映射
  - 位置使用相对中性眼的仿射位移
- 物体的远近透视由同一个离轴投影自动产生；头部 z 改变的是观察点，模型 z/depthM 改变的是物体相对屏幕的深度，两者不要混用。
- 窗户是投影视口，不是容器。单模型只是窗户场景中的一件内容，完整场景则把窗户锚定在场景中的开口；两者使用同一投影。模型为正 z 时会凸出窗户，靠近时根据真实距离自然变大；大型内容不会被自动缩放到窗口内。
- 当前示例模型的 X/Y 和统一缩放仍是场景资产参数；只有相对窗口深度明确使用米制换算。真实扫描场景应在导入时提供自己的单位比例或直接使用场景锚点。
- `visibleWidthM` 必须是实际渲染矩形的物理宽度，不是显示器对角线。高斯/网格资产不会自动缩放以适配窗口，资产尺寸和窗口尺寸是独立的。
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

目前不再保留任意增益的演示模式；需要评估真实几何时，直接测量渲染矩形宽度和眼屏距离，并重新校准中性位置。鼠标模式仅用于没有摄像头时的交互预览，仍使用同一窗口基准深度。

## 当前实现记录

- `web/lib/window-projection.ts`：从轴对齐简化矩阵升级为 generalized off-axis projection，支持固定物理屏幕基。
- `web/lib/window-tracking.ts`：物理模式改为围绕中性眼位的统一尺度仿射映射。
- `web/components/display-case.tsx` / `web/app/globals.css`：fullscreen 保持箱体宽高比。
- `web/tests/window.test.mjs`：增加旋转屏幕、剪切基底和物理映射回归测试。
- `docs/rendering-tracking-review-2026-09-06.md`：补充 Kooima 参考和当前物理映射结论。
