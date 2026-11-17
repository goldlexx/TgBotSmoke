from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
from html import escape

from .content import GREETINGS, THOUGHTS
from .db import MILESTONES
from .medical import ADDICTION, LIFE_MINUTES_PER_CIGARETTE, MODEL_NOTE, stage_line
from .timeutil import instant


@dataclass
class Stats:
    current_seconds: int
    total_seconds: int
    cigarettes: Decimal
    money: dict[str, Decimal]
    free_minutes: Decimal

    @property
    def life_minutes(self):
        return self.cigarettes * LIFE_MINUTES_PER_CIGARETTE


def calculate(streaks: list[dict], now: datetime) -> Stats:
    current = total = 0
    cigarettes = free = Decimal(0)
    money: dict[str, Decimal] = {}
    for streak in streaks:
        end = min(instant(streak["end"]), now) if streak["end"] else now
        seconds = max(0, int((end - instant(streak["start"])).total_seconds()))
        total += seconds
        if not streak["end"]:
            current = seconds
        avoided = Decimal(seconds) * int(streak["daily"]) / Decimal(86400)
        cigarettes += avoided
        currency = streak["currency"]
        money[currency] = money.get(currency, Decimal(0)) + avoided * Decimal(streak["price"]) / int(streak["pack"])
        free += avoided * Decimal(streak["minutes"])
    return Stats(current, total, cigarettes, money, free)


def number(value: Decimal) -> str:
    return f"{value.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP):,.2f}".replace(",", " ").replace(".", ",")


def duration(seconds: int) -> str:
    minutes = max(0, seconds) // 60
    days, rest = divmod(minutes, 1440)
    hours, mins = divmod(rest, 60)
    return f"{days} дн. {hours} ч. {mins} мин."


def goal(seconds: int) -> str:
    next_day = next((d for d in MILESTONES if seconds < d * 86400), None)
    if next_day is None:
        next_day = (seconds // (365 * 86400) + 1) * 365
    return f"{next_day} дн. в текущей серии — осталось {duration(next_day * 86400 - seconds)}"


def report(streaks: list[dict], now: datetime, local_day, user_id: int, morning: bool = False) -> str:
    s = calculate(streaks, now)
    index = local_day.toordinal() + user_id
    title = GREETINGS[index % len(GREETINGS)] if morning else "Ваш прогресс"
    money = " + ".join(f"{number(v)} {escape(k)}" for k, v in s.money.items())
    return (
        f"<b>🚭 НЕ КУРЮ · {title}</b>\n{local_day:%d.%m.%Y}\n\n"
        f"🚭 Текущая серия: <b>{duration(s.current_seconds)}</b>\n"
        f"📅 Всего в учтённых бездымных периодах: {duration(s.total_seconds)}\n"
        f"🚬 Не выкурено, оценка: <b>≈ {number(s.cigarettes)}</b>\n"
        f"💰 Сэкономлено, оценка: <b>≈ {money}</b>\n"
        f"⏳ Без перекуров: ≈ {duration(int((s.free_minutes * 60).to_integral_value(rounding=ROUND_HALF_UP)))}\n"
        f"❤️ Статистический эквивалент: ≈ {duration(int((s.life_minutes * 60).to_integral_value(rounding=ROUND_HALF_UP)))}\n"
        f'<i>{MODEL_NOTE}</i> <a href="{ADDICTION}">Исследование</a>\n\n'
        f"🫁 <b>Ориентир для текущей серии</b>\n{stage_line(s.current_seconds)}\n"
        f"<i>Сроки индивидуальны, это не медицинская гарантия.</i>\n\n"
        f"🎯 {goal(s.current_seconds)}\n\n"
        f"💬 {THOUGHTS[index % len(THOUGHTS)]}\n\n"
        "<i>Итоги — модель по прежнему расходу во всех бездымных периодах. "
        "Промежуток срыва исключён; фактические расходы и здоровье модель не измеряет.</i>"
    )
