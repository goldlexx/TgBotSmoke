from datetime import UTC, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
import re


def utcnow() -> datetime:
    return datetime.now(UTC)


def minute(value: datetime) -> datetime:
    return value.astimezone(UTC).replace(second=0, microsecond=0)


def stamp(value: datetime) -> str:
    return value.astimezone(UTC).isoformat(timespec="microseconds")


def instant(value: str) -> datetime:
    return datetime.fromisoformat(value).astimezone(UTC)


def timezone_name(value: str) -> str:
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError):
        raise ValueError("Неизвестный пояс. Пример: Europe/Moscow или Asia/Yekaterinburg.") from None
    return value


def clock(value: str) -> str:
    if not re.fullmatch(r"\d{1,2}:\d{2}", value):
        raise ValueError("Введите время в формате ЧЧ:ММ, например 08:00.")
    try:
        parsed = datetime.strptime(value, "%H:%M")
    except ValueError:
        raise ValueError("Часы: 00–23, минуты: 00–59.") from None
    return parsed.strftime("%H:%M")


def local_input(value: str, zone: str, now: datetime | None = None) -> datetime:
    now = now or utcnow()
    if value.casefold() in {"сейчас", "только что"}:
        return minute(now)
    tz = ZoneInfo(zone)
    parsed = None
    for fmt in ("%d.%m.%Y %H:%M %z", "%d.%m.%Y %H:%M"):
        try:
            parsed = datetime.strptime(value, fmt)
            break
        except ValueError:
            pass
    if parsed is None:
        raise ValueError("Введите ДД.ММ.ГГГГ ЧЧ:ММ, например 15.11.2026 21:30, или «Сейчас».")
    if parsed.tzinfo is not None:
        if parsed.astimezone(tz).replace(tzinfo=None) != parsed.replace(tzinfo=None):
            raise ValueError("Смещение UTC не соответствует выбранному часовому поясу.")
        result = parsed.astimezone(UTC)
    else:
        candidates = {
            parsed.replace(tzinfo=tz, fold=fold).astimezone(UTC)
            for fold in (0, 1)
            if parsed.replace(tzinfo=tz, fold=fold).astimezone(UTC).astimezone(tz).replace(tzinfo=None) == parsed
        }
        if not candidates:
            raise ValueError("Этого местного времени нет из-за перевода часов. Укажите другое время.")
        if len(candidates) > 1:
            raise ValueError("Время неоднозначно из-за перевода часов. Добавьте смещение, например +0200 или +0100.")
        result = candidates.pop()
    if result > now:
        raise ValueError("Последняя сигарета не может быть в будущем.")
    if result.year < 1900:
        raise ValueError("Укажите дату начиная с 1900 года.")
    return result
