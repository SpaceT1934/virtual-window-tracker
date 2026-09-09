from .config import LANDMARK_MODEL_URL, LBF_MODEL_URL, YUNET_MODEL_URL, Settings
from .model_loader import ensure_model, ensure_model_optional
from .tracker import FacePositionTracker


def create_tracker(settings: Settings):
    if settings.tracker_backend == 'landmarker':
        from .landmark_tracker import LandmarkPositionTracker
        path = ensure_model(settings.landmark_model_path, LANDMARK_MODEL_URL)
        return LandmarkPositionTracker(settings, path)
    if settings.tracker_backend == 'yunet':
        from .yunet_tracker import YuNetPositionTracker
        yunet_path = ensure_model(settings.yunet_model_path, YUNET_MODEL_URL)
        # LBF is an optional upgrade; a missing file must not block yunet.
        lbf_path = ensure_model_optional(settings.lbf_model_path, LBF_MODEL_URL)
        return YuNetPositionTracker(settings, yunet_path, lbf_path)
    if settings.tracker_backend != 'detector':
        raise ValueError('FACE_TRACKER_BACKEND must be detector, landmarker, or yunet')
    path = ensure_model(settings.model_path, settings.model_url)
    return FacePositionTracker(settings, path)
