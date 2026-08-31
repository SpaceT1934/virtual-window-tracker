import pytest

from face_tracker.filtering import OneEuroFilter


def test_first_value_is_not_delayed() -> None:
    filter_ = OneEuroFilter()
    assert filter_.apply(2.5, 1.0) == 2.5


def test_filter_smooths_a_step() -> None:
    filter_ = OneEuroFilter(min_cutoff=1.0, beta=0.0)
    filter_.apply(0.0, 0.0)
    value = filter_.apply(1.0, 1 / 30)
    assert 0.0 < value < 1.0


def test_invalid_cutoff_is_rejected() -> None:
    with pytest.raises(ValueError):
        OneEuroFilter(min_cutoff=0)

