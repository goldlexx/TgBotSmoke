from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, KeyboardButton, ReplyKeyboardMarkup

MENU_LABELS = ("📊 Мой прогресс", "🫁 Моё здоровье", "🏆 Достижения", "🆘 Хочу закурить", "⚙️ Настройки")
FIELDS = ("start", "daily", "cost", "pack", "minutes", "timezone", "report_time")
LABELS = {
    "start": "🚭 Последняя сигарета", "daily": "🚬 Сигарет в день", "cost": "💰 Цена и валюта пачки",
    "pack": "📦 Сигарет в пачке", "minutes": "⏳ Минут на сигарету",
    "timezone": "🌍 Часовой пояс", "report_time": "⏰ Утренний отчёт",
}
PROMPTS = {
    "start": "Когда была последняя сигарета?\nВведите ДД.ММ.ГГГГ ЧЧ:ММ или нажмите «Сейчас». Дата может быть в прошлом. Время — в вашем поясе (выберем далее).",
    "daily": "Сколько сигарет в день вы обычно выкуривали? Целое число от 1 до 200.",
    "cost": "Сколько стоит пачка и в какой валюте? Например: 250 RUB, 5.50 EUR или 1200 KZT. Цена до 1 000 000, до двух знаков после запятой; валюта — три латинские буквы.",
    "pack": "Сколько сигарет в пачке? От 1 до 100. По умолчанию — 20.",
    "minutes": "Сколько минут занимала одна сигарета? От 0,1 до 120; можно дробное число.",
    "timezone": "Ваш часовой пояс IANA? По умолчанию Europe/Moscow. Например: Asia/Yekaterinburg, Europe/Berlin.",
    "report_time": "Во сколько присылать утренний отчёт по вашему времени? Формат ЧЧ:ММ, по умолчанию 08:00.",
    "lapse_begin": "Когда начался срыв — была первая сигарета после отказа? Введите ДД.ММ.ГГГГ ЧЧ:ММ или «Сейчас» в вашем часовом поясе.",
    "lapse_last": "Когда была последняя сигарета во время срыва? От неё начнётся новая серия. Введите ДД.ММ.ГГГГ ЧЧ:ММ или «Сейчас». Для одной сигареты нажмите «Одна сигарета».",
}
CHOICES = {
    "start": ("Сейчас",), "daily": ("10", "20", "30"), "cost": ("200 RUB", "250 RUB", "300 RUB"),
    "pack": ("20", "25"), "minutes": ("5", "7", "10"),
    "timezone": ("Europe/Moscow", "Asia/Yekaterinburg", "Asia/Novosibirsk"),
    "report_time": ("08:00", "09:00", "10:00"), "lapse_begin": ("Сейчас",),
    "lapse_last": ("Одна сигарета", "Сейчас"),
}


def menu():
    return ReplyKeyboardMarkup(keyboard=[
        [KeyboardButton(text=MENU_LABELS[0]), KeyboardButton(text=MENU_LABELS[1])],
        [KeyboardButton(text=MENU_LABELS[2]), KeyboardButton(text=MENU_LABELS[3])],
        [KeyboardButton(text=MENU_LABELS[4])],
    ], resize_keyboard=True)


def choices(field: str):
    return ReplyKeyboardMarkup(
        keyboard=[[KeyboardButton(text=t)] for t in CHOICES[field]] + [[KeyboardButton(text="Отмена")]],
        resize_keyboard=True, input_field_placeholder="Введите ответ или нажмите кнопку",
    )


def settings():
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=LABELS[field], callback_data=f"edit:{field}")] for field in FIELDS
    ] + [[InlineKeyboardButton(text="↩️ Отметить срыв", callback_data="lapse")]])


def confirmation(nonce: str):
    return InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="Подтвердить срыв", callback_data=f"lapse:confirm:{nonce}"),
        InlineKeyboardButton(text="Отмена", callback_data="cancel"),
    ]])
