# Local face model options

The tracker currently supports MediaPipe BlazeFace and Face Landmarker. Candidate local upgrades are:

| Model | Strength | Tradeoff | Priority |
|---|---|---|---|
| MediaPipe Face Landmarker | 478 landmarks, CPU friendly, existing integration | Generic canonical geometry | 1 |
| 3DDFA-V2 | Strong pose under large yaw | Heavier ONNX/PyTorch runtime | 2 |
| 6DRepNet + face detector | Robust head pose | Does not provide dense eye landmarks | 3 |
| InsightFace 2D/3D | Mature detection and landmarks | Larger dependency and licensing review | 4 |

Models should implement the tracker adapter contract and expose normalized landmarks plus confidence.
