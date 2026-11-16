"""Проверено 16.11.2026. Популяционные ориентиры, не индивидуальный прогноз.

Порог — начало указанного диапазона, а не гарантированное завершение процесса.
"""
from dataclasses import dataclass

CDC = "https://www.cdc.gov/tobacco/about/benefits-of-quitting.html"
NHS = "https://www.nhs.uk/better-health/quit-smoking/"
WHO = "https://www.who.int/news-room/questions-and-answers/item/tobacco-health-benefits-of-smoking-cessation"
ADDICTION = "https://doi.org/10.1111/add.16757"
LIFE_MINUTES_PER_CIGARETTE = 20
MODEL_NOTE = (
    "20 мин/сигарету — популяционная оценка потерянной ожидаемой продолжительности жизни "
    "(Addiction, 2025). Это условный статистический эквивалент предотвращаемой потери, "
    "а не обещание лично прожить дольше на это время."
)


@dataclass(frozen=True)
class Stage:
    seconds: int
    label: str
    text: str
    source: str


STAGES = (
    Stage(20 * 60, "От 20 минут", "Частота пульса начинает снижаться после отказа от курения.", WHO),
    Stage(48 * 3600, "Примерно 48 часов", "Могут улучшаться вкус и обоняние.", NHS),
    Stage(72 * 3600, "Примерно 72 часа", "Бронхи начинают расслабляться; дышать может стать легче.", NHS),
    Stage(14 * 86400, "2–12 недель", "В этот период обычно улучшается кровообращение.", WHO),
    Stage(30 * 86400, "1–12 месяцев", "В этот период обычно уменьшаются кашель и одышка.", CDC),
    Stage(365 * 86400, "1–2 года", "Риск инфаркта заметно снижается по сравнению с продолжением курения.", CDC),
    Stage(3 * 365 * 86400, "3–6 лет", "Дополнительный риск ишемической болезни сердца снижается примерно наполовину.", CDC),
    Stage(10 * 365 * 86400, "10–15 лет", "Дополнительный риск рака лёгкого снижается примерно наполовину.", CDC),
)


def current_stage(seconds: int) -> Stage | None:
    return next((stage for stage in reversed(STAGES) if seconds >= stage.seconds), None)


def stage_line(seconds: int) -> str:
    stage = current_stage(seconds)
    if stage is None:
        return "Первые изменения начинаются вскоре после отказа. Ближайший ориентир — около 20 минут."
    return f'{stage.label}: {stage.text} <a href="{stage.source}">Источник</a>'


HEALTH_NOTE = (
    "Это типичные сроки из исследований, а не измерение состояния ваших органов. "
    "Индивидуальные изменения различаются; календарь не заменяет консультацию врача. "
    "Некоторые этапы описывают диапазоны; месяцы и годы в календаре приближены к 30 и 365 дням."
)
