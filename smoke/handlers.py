import logging
import re
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from html import escape
from zoneinfo import ZoneInfo
from uuid import uuid4

from aiogram import F, Router
from aiogram.enums import ChatType
from aiogram.filters import Command, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.types import CallbackQuery, ErrorEvent, Message

from . import ui
from .db import Database, MILESTONES
from .medical import ADDICTION, HEALTH_NOTE, MODEL_NOTE, STAGES, stage_line
from .stats import calculate, duration, report
from .timeutil import clock, instant, local_input, minute, stamp, timezone_name, utcnow

logger = logging.getLogger(__name__)


class Form(StatesGroup):
    value = State()
    confirm = State()


def numeric(text: str, lower: str, upper: str, integer=False):
    if not re.fullmatch(r"\d{1,7}(?:[.,]\d{1,2})?", text):
        raise ValueError("Введите число (не больше двух знаков после запятой).")
    try:
        value = Decimal(text.replace(",", "."))
    except InvalidOperation:
        raise ValueError("Введите число.") from None
    if not Decimal(lower) <= value <= Decimal(upper):
        raise ValueError(f"Допустимо от {lower} до {upper}.")
    if integer and value != value.to_integral_value():
        raise ValueError("Введите целое число.")
    return int(value) if integer else str(value)


def parse_field(field: str, text: str, zone: str):
    if field in {"start", "lapse_begin", "lapse_last"}:
        return stamp(local_input(text, zone))
    if field == "daily":
        return numeric(text, "1", "200", True)
    if field == "pack":
        return numeric(text, "1", "100", True)
    if field == "minutes":
        return numeric(text, "0.1", "120")
    if field == "cost":
        parts = text.upper().replace("₽", "RUB").replace("€", "EUR").replace("$", "USD").split()
        if len(parts) != 2 or not re.fullmatch(r"[A-Z]{3}", parts[1]):
            raise ValueError("Введите цену и валюту через пробел, например 250 RUB или 5,50 EUR.")
        return {"price": numeric(parts[0], "0.01", "1000000"), "currency": parts[1]}
    if field == "timezone":
        return timezone_name(text)
    if field == "report_time":
        return clock(text)
    raise ValueError("Неизвестное поле.")


async def prompt(message: Message, field: str):
    await message.answer(ui.PROMPTS[field], reply_markup=ui.choices(field))


def validate_registration_date(text: str, now: datetime):
    parsed = None
    for fmt in ("%d.%m.%Y %H:%M", "%d.%m.%Y %H:%M %z"):
        try:
            parsed = datetime.strptime(text, fmt)
            break
        except ValueError:
            pass
    if parsed is None:
        raise ValueError("Введите дату ДД.ММ.ГГГГ ЧЧ:ММ или нажмите «Сейчас».")
    if parsed.year < 1900:
        raise ValueError("Укажите дату начиная с 1900 года.")
    # Без пояса отклоняем только даты, будущие даже в самом восточном поясе.
    earliest = parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC) - timedelta(hours=14)
    if minute(earliest) > minute(now):
        raise ValueError("Последняя сигарета не может быть в будущем.")


def build_router(db: Database) -> Router:
    router = Router()
    router.message.filter(F.chat.type == ChatType.PRIVATE)
    router.callback_query.filter(F.message.chat.type == ChatType.PRIVATE)

    @router.message(CommandStart())
    async def start(message: Message, state: FSMContext):
        user_id = message.from_user.id
        if db.user(user_id):
            db.enabled(user_id, True)
            await state.clear()
            await message.answer("🚭 <b>НЕ КУРЮ</b>\nВаш прогресс сохранён. Выберите раздел.", reply_markup=ui.menu())
            return
        data = await state.get_data()
        if await state.get_state() == Form.value.state and data.get("mode") == "register":
            await message.answer("Продолжим регистрацию. Для начала заново: /cancel, затем /start.")
            await prompt(message, data["field"])
            return
        await state.set_state(Form.value)
        await state.set_data({"mode": "register", "field": "start", "remaining": list(ui.FIELDS[1:]), "draft": {}})
        await message.answer(
            "🚭 <b>НЕ КУРЮ</b>\nПомогу следить за отказом от сигарет. Задам семь коротких вопросов.\n"
            "Статистика — оценка по прежним привычкам, медицинские сроки индивидуальны. "
            "Данные сохраняются у владельца бота. Лучше пользоваться личным чатом."
        )
        await prompt(message, "start")

    @router.message(Command("cancel"))
    @router.message(F.text == "Отмена")
    async def cancel(message: Message, state: FSMContext):
        await state.clear()
        if db.user(message.from_user.id):
            await message.answer("Ввод отменён.", reply_markup=ui.menu())
        else:
            from aiogram.types import ReplyKeyboardRemove
            await message.answer("Ввод отменён. Начать регистрацию: /start", reply_markup=ReplyKeyboardRemove())

    @router.callback_query(F.data == "cancel")
    async def cancel_callback(callback: CallbackQuery, state: FSMContext):
        await callback.answer()
        await state.clear()
        await callback.message.edit_reply_markup(reply_markup=None)
        await callback.message.answer("Отменено.", reply_markup=ui.menu())

    @router.callback_query(F.data.startswith("edit:"))
    async def edit(callback: CallbackQuery, state: FSMContext):
        await callback.answer()
        user = db.user(callback.from_user.id)
        if not user:
            await callback.message.answer("Сначала /start.")
            return
        field = callback.data.split(":", 1)[1]
        if field not in ui.FIELDS:
            return
        await state.set_state(Form.value)
        await state.set_data({"mode": "edit", "field": field, "timezone": user["timezone"]})
        await prompt(callback.message, field)
        if field == "start":
            await callback.message.answer(f"Время вводите в поясе {escape(user['timezone'])}. Исправление даты пересчитает текущую серию.")

    @router.callback_query(F.data == "lapse")
    async def lapse(callback: CallbackQuery, state: FSMContext):
        await callback.answer()
        user_id = callback.from_user.id
        user = db.user(user_id)
        if not user:
            await callback.message.answer("Сначала /start.")
            return
        active = db.streaks(user_id)[-1]
        await state.set_state(Form.value)
        await state.set_data({"mode": "lapse", "field": "lapse_begin", "timezone": user["timezone"], "streak_id": active["id"]})
        await callback.message.answer(
            "Срыв не стирает сделанного. Укажем его начало и последнюю сигарету. "
            "Промежуток курения исключим из общих итогов, старые достижения сохраним.\n"
            f"Ваш часовой пояс: {escape(user['timezone'])}."
        )
        await prompt(callback.message, "lapse_begin")

    @router.callback_query(F.data.startswith("lapse:confirm:"))
    async def confirm_lapse(callback: CallbackQuery, state: FSMContext):
        await callback.answer()
        data = await state.get_data()
        if (await state.get_state() != Form.confirm.state or data.get("mode") != "lapse"
                or callback.data.rsplit(":", 1)[-1] != data.get("nonce")):
            await callback.message.answer("Эта отметка уже обработана или отменена.")
            return
        try:
            db.lapse(callback.from_user.id, data["streak_id"], instant(data["began"]), instant(data["last"]))
        except ValueError as exc:
            await callback.message.answer(escape(str(exc)), reply_markup=ui.menu())
        else:
            await callback.message.answer("Новая серия началась с последней сигареты. Прошлые периоды и достижения сохранены. Продолжаем!", reply_markup=ui.menu())
        await state.clear()
        await callback.message.edit_reply_markup(reply_markup=None)

    @router.message(Form.value)
    async def value(message: Message, state: FSMContext):
        if not message.text:
            await message.answer("Нужен текст или кнопка с ответом.")
            return
        data = await state.get_data()
        text = message.text.strip()
        mode, field = data["mode"], data["field"]
        zone = data.get("timezone", "Europe/Moscow")
        try:
            if mode == "register":
                draft = data["draft"]
                if field == "start" and not data.get("date_final"):
                    # Пояс узнаем позже; окончательная проверка будет после его выбора.
                    if text.casefold() in {"сейчас", "только что"}:
                        draft["start"] = stamp(minute(utcnow()))
                        draft.pop("start_input", None)
                    else:
                        validate_registration_date(text, utcnow())
                        draft["start_input"] = text
                elif field == "start":
                    draft["start"] = parse_field(field, text, draft["timezone"])
                    draft.pop("start_input", None)
                else:
                    parsed = parse_field(field, text, zone)
                    draft.update(parsed) if field == "cost" else draft.update({field: parsed})
                if field == "timezone" and "start_input" in draft:
                    try:
                        draft["start"] = stamp(local_input(draft["start_input"], draft["timezone"]))
                        draft.pop("start_input")
                    except ValueError as exc:
                        await state.update_data(draft=draft, field="start", date_final=True)
                        await message.answer(f"Пояс сохранён. Уточните дату: {escape(str(exc))}")
                        await prompt(message, "start")
                        return
                remaining = data["remaining"]
                if remaining:
                    next_field, *remaining = remaining
                    await state.update_data(draft=draft, field=next_field, remaining=remaining)
                    await prompt(message, next_field)
                else:
                    db.register(message.from_user.id, message.chat.id, draft, instant(draft["start"]))
                    await state.clear()
                    await message.answer("Готово! Отсчёт идёт с последней сигареты. Утренние отчёты будут приходить по вашему местному времени.", reply_markup=ui.menu())
                    await show_progress(message)
            elif mode == "edit":
                parsed = parse_field(field, text, zone)
                if field == "cost":
                    db.change_cost(message.from_user.id, parsed)
                else:
                    db.change(message.from_user.id, field, instant(parsed) if field == "start" else parsed)
                await state.clear()
                await message.answer("Сохранено. Параметры расхода пересчитывают текущую серию; завершённые периоды сохраняют прежние значения.", reply_markup=ui.menu())
            elif mode == "lapse":
                if field == "lapse_begin":
                    began = parse_field(field, text, zone)
                    active = db.streaks(message.from_user.id)[-1]
                    if minute(instant(began)) < minute(instant(active["start"])):
                        raise ValueError("Начало срыва не может быть раньше начала текущей серии.")
                    await state.update_data(began=began, field="lapse_last")
                    await prompt(message, "lapse_last")
                else:
                    last = data["began"] if text == "Одна сигарета" else parse_field(field, text, zone)
                    if minute(instant(last)) < minute(instant(data["began"])):
                        raise ValueError("Последняя сигарета должна быть не раньше начала срыва.")
                    nonce = uuid4().hex
                    await state.update_data(last=last, nonce=nonce)
                    await state.set_state(Form.confirm)
                    fmt = lambda v: instant(v).astimezone(ZoneInfo(zone)).strftime("%d.%m.%Y %H:%M")
                    await message.answer(
                        f"Начало срыва: {fmt(data['began'])}\nПоследняя сигарета: {fmt(last)}\n"
                        "Текущая серия начнётся заново, достижения останутся. Подтвердите запись.",
                        reply_markup=ui.confirmation(nonce),
                    )
        except ValueError as exc:
            await message.answer(escape(str(exc)))

    @router.message(Form.confirm)
    async def waiting_confirmation(message: Message):
        await message.answer("Подтвердите запись кнопкой выше или нажмите «Отмена».")

    async def show_progress(message: Message):
        user_id = message.from_user.id
        user = db.user(user_id)
        if not user:
            await message.answer("Для начала ответьте на вопросы: /start")
            return
        now = utcnow()
        db.awards(user_id, now)
        await message.answer(report(db.streaks(user_id), now, now.astimezone(ZoneInfo(user["timezone"])).date(), user_id), reply_markup=ui.menu())

    @router.message(F.text == ui.MENU_LABELS[0])
    async def progress(message: Message):
        await show_progress(message)

    @router.message(F.text == ui.MENU_LABELS[1])
    async def health(message: Message):
        user_id = message.from_user.id
        if not db.user(user_id):
            await message.answer("Сначала /start.")
            return
        seconds = calculate(db.streaks(user_id), utcnow()).current_seconds
        lines = ["<b>🫁 Моё здоровье</b>", stage_line(seconds), "", "<b>Календарь восстановления</b>"]
        lines += [f'{"•" if seconds < s.seconds else "✓"} {s.label}: {s.text} <a href="{s.source}">Источник</a>' for s in STAGES]
        lines += ["", HEALTH_NOTE, "", f'{MODEL_NOTE} <a href="{ADDICTION}">Исследование</a>']
        await message.answer("\n".join(lines))

    @router.message(F.text == ui.MENU_LABELS[2])
    async def achievements(message: Message):
        user_id = message.from_user.id
        if not db.user(user_id):
            await message.answer("Сначала /start.")
            return
        now = utcnow()
        awards = db.awards(user_id, now)
        seconds = calculate(db.streaks(user_id), now).current_seconds
        lines = ["<b>🏆 Достижения</b>", "Награды за непрерывную серию остаются после срыва.", ""]
        for days in MILESTONES:
            status = "🏅 сохранено" if days in awards else "🔒 впереди"
            if seconds >= days * 86400:
                status += " · есть в текущей серии"
            lines.append(f"{days} дн. — {status}")
        await message.answer("\n".join(lines))

    @router.message(F.text == ui.MENU_LABELS[3])
    async def craving(message: Message):
        await message.answer(
            "<b>🆘 Переживём эту волну тяги</b>\n\n"
            "1. Отложите решение на 5 минут. Сейчас нужна только короткая пауза.\n"
            "2. Сделайте несколько медленных комфортных вдохов и выдохов.\n"
            "3. Выпейте воды; займите руки или возьмите жевательную резинку без сахара.\n"
            "4. Смените обстановку: отойдите от курящих, немного пройдитесь.\n"
            "5. Напишите человеку, который поддерживает ваш отказ.\n\n"
            "Если тяга мешает справляться, обсудите с врачом или фармацевтом средства для отказа от курения.\n"
            '<a href="https://www.nhs.uk/better-health/quit-smoking/staying-smoke-free/">Советы NHS</a>\n\n'
            "Если уже закурили, отметьте срыв в настройках и продолжайте. Один эпизод не стирает ваш опыт."
        )

    @router.message(F.text == ui.MENU_LABELS[4])
    async def settings(message: Message):
        user_id = message.from_user.id
        user = db.user(user_id)
        if not user:
            await message.answer("Сначала /start.")
            return
        active = db.streaks(user_id)[-1]
        date = instant(active["start"]).astimezone(ZoneInfo(user["timezone"])).strftime("%d.%m.%Y %H:%M")
        await message.answer(
            f"<b>⚙️ Настройки</b>\nПоследняя сигарета: {date}\n"
            f"Прежний расход: {user['daily']} сиг./день\nПачка: {user['price']} {user['currency']}, {user['pack']} сиг.\n"
            f"Перекур: {user['minutes']} мин.\nПояс: {escape(user['timezone'])}\nОтчёт: {user['report_time']}\n\n"
            "Изменение расхода, цены и длительности пересчитает текущую серию. Завершённые периоды сохранят свои параметры. "
            "Валюты в общих итогах учитываются отдельно, без конвертации.", reply_markup=ui.settings(),
        )

    @router.message()
    async def fallback(message: Message):
        await message.answer("Выберите раздел меню или начните с /start.", reply_markup=ui.menu() if db.user(message.from_user.id) else None)

    @router.errors()
    async def error(event: ErrorEvent):
        # Не пишем exception/message: сетевые ошибки могут содержать URL с токеном.
        logger.error("Ошибка обработки обновления: %s", type(event.exception).__name__)
        message = event.update.message or (event.update.callback_query.message if event.update.callback_query else None)
        if isinstance(message, Message):
            try:
                await message.answer("Не удалось обработать действие. Попробуйте ещё раз или используйте /start. Сохранённые данные остаются в базе.")
            except Exception:
                pass
        return True

    return router
