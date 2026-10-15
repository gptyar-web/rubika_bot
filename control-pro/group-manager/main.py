import database
import config
import game
import random
import tempfile
import requests
# import timepip
import re
from taw_bio import TawBio
from warning import warn_user
from warn_from_admin import HandleWarns
from rubpy.enums import ParseMode
from rubpy import Client, filters, utils
from datetime import datetime
from apscheduler.schedulers.background import BackgroundScheduler
from rubpy.types import Update
import os

ADMINS = ['u0IUNYg01533c1a7004bbd05aa385225','u0HvRzl0aed3a855d691bd05f4869c36']
bot = Client('hool')
taw_bio = TawBio()
session = database.Session()
HASHTAG_RE = re.compile(r'\#\w+')
LINK_RE = re.compile(r'https?://\S+')
scheduler = BackgroundScheduler()
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
HELP_PATH = os.path.join(BASE_DIR, 'help.txt')
with open(HELP_PATH, 'r', encoding='utf-8') as file:
    HELP_TEXT = file.read()
# HELP_TEXT = open(r'./help.txt', 'r', encoding='utf-8').read()
PERSIAN_RE = re.compile(r'[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]+')
symbols = {2: 'X', 1: 'O'}
game_data = {}

BADWORDS = [""]



@bot.on_message_updates(filters.text)
def get_my_guid(update: Update):
    print(update.author_guid)

def get_int(value: str):
    try:
        return int(value)

    except (ValueError, TypeError):
        return None

def get_filename():
    return str(random.random()) + '.jpg'

def delete_unauthenticated_users():
    """حذف کاربرانی که مقدار auth آن‌ها False است"""
    session.query(database.UserAuthentication).filter_by(auth=False).delete()
    session.commit()
    print(f"Users with 'False' authentication status have been removed - {datetime.now()}")

def generate_math_equation(group_guid: str, user_guid: int) -> str:
    """تولید یک معادله ریاضی ساده و ذخیره نتیجه مورد انتظار در دیتابیس"""
    num1 = random.randint(1, 10)
    num2 = random.randint(1, 10)
    result = num1 + num2

    equation = f"{num1} + {num2} = ?"

    # ذخیره نتیجه مورد انتظار در دیتابیس
    auth_record = database.UserAuthentication(group_guid=group_guid, user_guid=user_guid, equation=equation, expected_result=result)
    session.add(auth_record)
    session.commit()

    return equation


def is_badword(word_list, text):
    # Change text and words to low mode
    words = [word.lower() for word in word_list]
    text = text.lower()

    # Make pattern By using the words
    pattern = re.compile(rf'\b(?:{"|".join(map(re.escape, words))})\b')

    # Search in text
    return bool(pattern.search(text))

def authenticate_user(update: Update) -> None:
    # تولید معادله ریاضی و ذخیره نتیجه مورد انتظار در دیتابیس
    equation = generate_math_equation(update.object_guid, update.author_guid)

    # درخواست احراز هویت از کاربر
    author = update.get_author().user
    update.reply(f'[@{author.username}]({update.author_guid})\nبرای احراز هویت، لطفاً معادله ریاضی زیر را حل کنید:[حتما پاسخ را روی این پیام ریپلای کنید.]\n\n{equation}',
                 parse_mode=ParseMode.MARKDOWN)
    update.delete()

def is_bug(update: Update, result):
    try:
        if update.file_inline and update.file_inline.type in ['Voice', 'Music', 'Video']:
            if update.file_inline.time is None:
                return update.is_group

    except AttributeError:
        pass

    return update.is_group and update.text and r'‌‌‌‌‌‍‍          ‍‍' in update.text


@bot.on_message_updates(filters.is_group)
def filter_add_command(update: Update):
    if not update.text:
        return

    # فقط اگر با "!" شروع شود
    if not update.text.startswith('!'):
        return

    parts = update.text.split(maxsplit=1)

    if not update.is_admin(user_guid=update.author_guid):
        return

    if len(parts) < 2 or not parts[1].strip():
        return update.reply("لطفاً بعد از ! کلمه‌ای را برای فیلتر وارد کنید. مثلا:\n`!کلمه‌بد`", parse_mode=ParseMode.MARKDOWN)

    word = parts[1].strip()

    group_guid = update.object_guid

    existing = session.query(database.FilterWord).filter_by(group_guid=group_guid, word=word).first()
    if existing:
        return update.reply("این کلمه قبلاً فیلتر شده است.")

    new_word = database.FilterWord(group_guid=group_guid, word=word)
    session.add(new_word)
    session.commit()

    update.reply(f"✅ کلمه «{word}» به لیست فیلتر افزوده شد.")


@bot.on_message_updates(filters.is_group, filters.commands(['انفیلتر'], prefixes=''))
def delete_filter_word(update: Update):
    if not update.text:
        return

    if not update.text.startswith('انفیلتر'):
        return

    parts = update.text.split(maxsplit=1)
    if not update.is_admin(user_guid=update.author_guid):
        return update.reply("فقط مدیران می‌توانند از این دستور استفاده کنند.")

    if len(parts) < 2 or not parts[1].strip():
        return update.reply("لطفاً بعد از دستور کلمه‌ای را برای حذف وارد کنید. مثال:\n/حذف_فیلتر کلمه", parse_mode=ParseMode.MARKDOWN)

    word = parts[1].strip()
    group_guid = update.object_guid

    existing = session.query(database.FilterWord).filter_by(group_guid=group_guid, word=word).first()
    if not existing:
        return update.reply("❌ این کلمه در لیست فیلتر وجود ندارد.")

    session.delete(existing)
    session.commit()

    update.reply(f"✅ کلمه «{word}» از لیست فیلتر حذف شد.")


@bot.on_message_updates(filters.is_group)
def check_filter_words(update: Update):

    user_guid = update.author_guid
    info = update.client.get_info(object_guid=user_guid)
    first_name = info["user"].get("first_name", "")
    last_name = info["user"].get("last_name", "")
    full_name = f"{first_name} {last_name}".strip() or "کاربر"
    mention = f"[{full_name}]({update.author_guid})"
    words = session.query(database.FilterWord).filter_by(group_guid=update.object_guid).all()
    if not words or not update.text:
        return

    msg_text = update.text.strip().lower()
    for word_obj in words:
        if word_obj.word.lower() in msg_text:

            try:
                if update.is_admin(user_guid= update.author_guid):
                    return
                # حذف پیام
                update.delete()

                # ثبت اخطار
                warning = database.Warning(
                    group_guid=update.object_guid,
                    user_guid=update.author_guid,
                    reason=f"کلمه ممنوعه: {word_obj.word}"
                )
                session.add(warning)
                session.commit()

                # شمارش اخطار
                count = session.query(database.Warning).filter_by(
                    group_guid=update.object_guid,
                    user_guid=update.author_guid
                ).count()

                # پاسخ
                update.reply(
                    f"⚠️ {mention}\n"
                    f"شما از کلمه فیلتر شده استفاده کردید: «{word_obj.word}»\n"
                    f"تعداد اخطارهای شما: {count}/3",
                    parse_mode=ParseMode.MARKDOWN
                )

                # بن اگر ۳ بار تکرار شد
                if count >= 3:
                    existing_ban = session.query(database.BannedUser).filter_by(
                        group_guid=update.object_guid,
                        user_guid=update.author_guid
                    ).first()
                    if not existing_ban:
                        session.add(database.BannedUser(
                            group_guid=update.object_guid,
                            user_guid=update.author_guid
                        ))
                        session.commit()
                        update.ban_member(user_guid=update.author_guid)
                        return update.reply_user(f"⛔️ {mention} به دلیل دریافت ۳ اخطار از گروه بن شد.")

            except Exception as e:
                print("خطا در فیلتر:", e)
            break

@bot.on_message_updates(filters.is_group, filters.commands(['لیست فیلترها'], prefixes=''))
def show_filter_list(update: Update):

    if not update.is_admin(user_guid=update.author_guid):
        return

    words = session.query(database.FilterWord).filter_by(group_guid=update.object_guid).all()
    if not words:
        return update.reply("🚫 هیچ کلمه‌ای فیلتر نشده است.")

    text = "📋 لیست کلمات فیلتر شده:\n\n"
    for i, w in enumerate(words, 1):
        text += f"{i}. {w.word}\n"

    update.reply(text)

@bot.on_message_updates(filters.is_group, filters.commands(['حذف اخطار'], prefixes=''))
def remove_user_warnings(update: Update):
    if not update.is_admin(user_guid=update.author_guid):
        return

    if not update.reply_message_id:
        return update.reply("⛔ لطفاً روی پیام کاربر مورد نظر ریپلای کنید.")

    try:
        # گرفتن user_guid از پیام ریپلای شده
        replied_msg = update.get_messages(message_ids=update.reply_message_id).messages[0]
        target_guid = replied_msg.author_object_guid

        # حذف اخطارها
        session.query(database.Warning).filter_by(
            group_guid=update.object_guid,
            user_guid=target_guid
        ).delete()
        session.commit()

        update.reply("✅ همه اخطارهای این کاربر پاک شدند.")

    except Exception as e:
        print("خطا در حذف اخطار:", e)
        update.reply("⚠️ خطایی رخ داد هنگام حذف اخطارها.")


@bot.on_message_updates(filters.is_group, filters.commands(['لیست ادمین ها'], prefixes=''))
def list_admins(update: Update):
    group_guid = update.object_guid

    # فقط اگر پیام‌دهنده خودش ادمین باشد
    if not update.is_admin(user_guid=update.author_guid):
        return

    # واکشی لیست ادمین‌ها از دیتابیس
    admins = session.query(database.GroupAdmin).filter_by(group_guid=group_guid).all()

    if not admins:
        return update.reply("🚫 لیستی از ادمین‌ها یافت نشد.")

    text = "👮‍♂️ لیست ادمین‌های این گروه:\n\n"
    for index, admin in enumerate(admins, start=1):
        user = session.query(database.User).filter_by(user_guid=admin.user_guid).first()
        info = update.client.get_info(object_guid= admin.user_guid)
        first_name = info["user"].get("first_name", "")
        last_name = info["user"].get("last_name", "")
        full_name = f"{first_name} {last_name}".strip()
        mention = f"[{full_name}]({user.user_guid})"
        text += f"{index}- {mention}\n"

            # اگر اطلاعات ثبت شده باشد، منشن با نام کامل بساز
            # name = f"{user.username}" if user.username else f"{user.user_guid}"




    update.reply(text, parse_mode=ParseMode.MARKDOWN)


@bot.on_message_updates(is_bug)
async def delete_bug(update: Update):
    group = session.query(database.Group).filter_by(group_guid=update.object_guid).first()
    if group:
        await update.reply('یک کاربر باگ ارسال کرد و حذف شد.')
        await update.delete()
        await update.ban_member()

@bot.on_message_updates(filters.is_group, filters.commands(['بیو', 'bio'], ''))
def send_bio(update: Update):
    group = session.query(database.Group).filter_by(group_guid=update.object_guid).first()
    if group:
        bio = taw_bio.get_bio()
        text = bio.fa.replace('<br />', '\n')
        keyword = bio.keyword.replace(' ', '_')
        return update.reply(f'{text}\n\n#{keyword}')

@bot.on_message_updates(filters.is_group, filters.commands(['ویسکال', 'کال'], prefixes=['', '!']))
def make_voicecall(update: Update):
    group = session.query(database.Group).filter_by(group_guid=update.object_guid).first()
    url = update.text.split()[-1]

    if group and update.is_admin():
        bot.create_group_voice_chat(group_guid=update.object_guid)
        update.reply(f"کال ایجاد شد!")



@bot.on_message_updates(filters.is_group)
def learn_response(update: Update):
    if not update.text or " !! " not in update.text:
        return

    if not update.is_admin(user_guid=update.author_guid):
        return

    parts = update.text.split(" !! ")
    if len(parts) != 2:
        return

    trigger, response = parts
    trigger = trigger.strip()
    response = response.strip()

    if not trigger or not response:
        return

    # ذخیره در دیتابیس
    session.add(database.LearnedResponse(group_guid=update.object_guid, trigger=trigger, response=response))
    session.commit()
    update.reply(f"یادگرفتم✅")



@bot.on_message_updates(filters.is_group)
def respond_to_trigger(update: Update):

    if not update.text:
        return

    text = update.text.strip()

    # جستجو در دیتابیس
    responses = session.query(database.LearnedResponse).filter_by(group_guid=update.object_guid, trigger=text).all()

    for resp in responses:
        update.reply(resp.response)

@bot.on_message_updates(filters.is_group)
def delete_learned_response(update: Update):
    if not update.text or not update.text.endswith("!!"):
        return

    if not update.is_admin(user_guid=update.author_guid):
        return

    trigger = update.text.replace("!!", "").strip()
    if not trigger:
        return

    deleted = session.query(database.LearnedResponse).filter_by(group_guid=update.object_guid, trigger=trigger).delete()
    session.commit()

    if deleted:
        update.reply(f" جواب های«{trigger}» یادم رفت❌")
    else:
        update.reply("چیزی برای حذف یافت نشد.")


@bot.on_message_updates(filters.is_group, filters.commands(['ارتقا'], prefixes=''))
def promote_to_admin(update: Update):
    group_guid = update.object_guid
    user_guid = update.get_messages(message_ids=update.reply_message_id).messages[0].author_object_guid
    info = update.client.get_info(object_guid=user_guid)
    first_name = info["user"].get("first_name", "")
    last_name = info["user"].get("last_name", "")
    full_name = f"{first_name} {last_name}".strip() or "کاربر"
    mention = f"[{full_name}]({user_guid})"
    # فقط اگر این شخص خودش ادمین گروه باشه
    # is_admin = session.query(database.GroupAdmin).filter_by(group_guid=group_guid, user_guid=author_guid).first()
    if not update.is_admin(user_guid=update.author_guid):
        return
    # اگر ریپلای کرد
    if update.reply_message_id:
        try:
            replied_msg = update.get_messages(message_ids=update.reply_message_id).messages[0]
            target_guid = replied_msg.author_object_guid
        except:
            return update.reply("خطا در دریافت پیام ریپلای.")

    # یا اگر یوزرنیم یا آیدی وارد کرده
    else:
        parts = update.text.split()
        if len(parts) < 2:
            return update.reply("لطفاً با ریپلای یا نوشتن آیدی یا یوزرنیم ارتقا بدید. مثال: `ارتقا @username`", parse_mode=ParseMode.MARKDOWN)

        identifier = parts[1].lstrip('@')
        user = session.query(database.User).filter((database.User.username == identifier) | (database.User.user_guid == identifier)).first()
        if not user:
            return update.reply("کاربر مورد نظر در دیتابیس پیدا نشد.")
        target_guid = user.user_guid

    if target_guid == bot.guid:
        return update.reply("ایشون منم")

    # بررسی وجود قبلی در جدول
    existing = session.query(database.GroupAdmin).filter_by(group_guid=group_guid, user_guid=target_guid).first()
    if existing:
        return update.reply(f"{mention}  قبلاً ادمین شده است.")

    # ثبت در دیتابیس
    session.add(database.GroupAdmin(group_guid=group_guid, user_guid=target_guid))
    bot.set_group_admin(group_guid, target_guid)
    session.commit()
    return update.reply(f"✅ {mention}با موفقیت به ادمین‌های گروه اضافه شد.")

@bot.on_message_updates(filters.is_group, filters.commands(['عزل'], prefixes=''))
def promote_to_admin(update: Update):
    group_guid = update.object_guid
    user_guid = update.get_messages(message_ids=update.reply_message_id).messages[0].author_object_guid
    info = update.client.get_info(object_guid=user_guid)
    first_name = info["user"].get("first_name", "")
    last_name = info["user"].get("last_name", "")
    full_name = f"{first_name} {last_name}".strip() or "کاربر"
    mention = f"[{full_name}]({user_guid})"
    # فقط اگر این شخص خودش ادمین گروه باشه
    # is_admin = session.query(database.GroupAdmin).filter_by(group_guid=group_guid, user_guid=author_guid).first()
    if not update.is_admin(user_guid=update.author_guid):
        return
    # اگر ریپلای کرد
    if update.reply_message_id:
        try:
            replied_msg = update.get_messages(message_ids=update.reply_message_id).messages[0]
            target_guid = replied_msg.author_object_guid
        except:
            return update.reply("خطا در دریافت پیام ریپلای.")

    # یا اگر یوزرنیم یا آیدی وارد کرده
    else:
        parts = update.text.split()
        if len(parts) < 2:
            return update.reply("لطفاً با ریپلای یا نوشتن آیدی یا یوزرنیم عزل کنید. مثال: `عزل @username`", parse_mode=ParseMode.MARKDOWN)

        identifier = parts[1].lstrip('@')
        user = session.query(database.User).filter((database.User.username == identifier) | (database.User.user_guid == identifier)).first()
        if not user:
            return update.reply("کاربر مورد نظر در دیتابیس پیدا نشد.")
        target_guid = user.user_guid

    # بررسی وجود قبلی در جدول
    if target_guid == bot.guid:
        return update.reply("ایشون منم")

    existing = session.query(database.GroupAdmin).filter_by(group_guid=group_guid, user_guid=target_guid).first()
    if not existing:
        return update.reply(F"{mention} ادمین نیست.")

    # ثبت در دیتابیس
    session.delete(existing)
    session.commit()
    bot.set_group_admin(group_guid, target_guid, "UnsetAdmin")
    return update.reply(F"✅  {mention} با موفقیت از ادمین‌های گروه عزل شد.")


@bot.on_message_updates(filters.is_group, filters.commands(['فونت', 'font'], ''))
def send_font(update: Update):
    group = session.query(database.Group).filter_by(group_guid=update.object_guid).first()
    if group:
        text = update.text[4:].strip()
        params = {'text': text}
        if PERSIAN_RE.search(text):
            params['type'] = 'fa'
            response = requests.get('https://api.codebazan.ir/font/', params=params).json()
            result = response.get('Result').get(str(random.randint(1, 10)))
            return update.reply(f'**فونت شما:** {result}', parse_mode=ParseMode.MARKDOWN)

        response = requests.get('https://api.codebazan.ir/font/', params=params).json()
        result = response.get('result').get(str(random.randint(1, 138)))
        return update.reply(f'**فونت شما:** {result}', parse_mode=ParseMode.MARKDOWN)

@bot.on_message_updates(filters.is_group, filters.regex(r'^ربات بگو'))
async def echo(update: Update):
    group = session.query(database.Group).filter_by(group_guid=update.object_guid).first()
    if group and await update.is_admin(user_guid=update.author_guid):
        echo_text = update.text[8:]
        # await update.delete()
        if update.reply_message_id:
            return await update.reply(echo_text, reply_to_message_id=update.reply_message_id)

        return await update.reply(echo_text)

@bot.on_message_updates(filters.is_group, filters.commands('راهنما', ''))
async def send_help_to_admin(update: Update):
    group = session.query(database.Group).filter_by(group_guid=update.object_guid).first()
    if group and await update.is_admin(user_guid=update.author_guid):
        return await update.reply(HELP_TEXT, parse_mode=ParseMode.MARKDOWN)

@bot.on_message_updates(filters.is_group, filters.commands(['لینک', 'link'], ''))
async def send_group_link(update: Update):
    group = session.query(database.Group).filter_by(group_guid=update.object_guid).first()
    if group:
        link = await bot.get_group_link(update.object_guid)
        return await update.reply(f'🏷 **گروه: {group.name}**\n┈┅┅━✦━┅┅┈\n{link.join_link}',
                                  parse_mode=ParseMode.MARKDOWN)

async def send_help_to_admin(update: Update):
    group = session.query(database.Group).filter_by(group_guid=update.object_guid).first()
    if group and await update.is_admin(user_guid=update.author_guid):
        return await update.reply(HELP_TEXT, parse_mode=ParseMode.MARKDOWN)

@bot.on_message_updates(filters.is_group, filters.commands('قفل', ''))
def handle_lock_command(update: Update):
    """تنظیم قفل موردنظر در گروه"""
    group = session.query(database.Group).filter_by(group_guid=update.object_guid).first()
    lock_type = update.text[3:].strip()

    if group and update.is_admin(user_guid=update.author_guid):
        if not lock_type:
            update.reply("لطفاً نوع قفل را وارد کنید. برای مثال: `قفل لینک`", parse_mode=ParseMode.MARKDOWN)
            return

        lock_name = None
        for key, value in config.LOCK_TYPES.items():
            if value == lock_type:
                lock_name = value
                lock_type = key
                break

        if lock_name is not None and hasattr(group, f"lock_{lock_type}"):
            # تغییر وضعیت قفل موردنظر
            current_lock_status = getattr(group, f"lock_{lock_type}")
            setattr(group, f"lock_{lock_type}", not current_lock_status)

            session.commit()
            lock_status_str = "فعال" if getattr(group, f"lock_{lock_type}") else "غیرفعال"
            update.reply(f"قفل {lock_name} با موفقیت {lock_status_str} شد.")
        else:
            update.reply("نوع قفل نامعتبر است.")

@bot.on_message_updates(filters.is_group)
def save_user_info(update: Update) -> None:
    group = session.query(database.Group).filter_by(group_guid=update.object_guid).first()
    if group:
        """ذخیره اطلاعات کاربر در صورت عدم وجود در دیتابیس"""
        user_id = update.author_guid
        user = session.query(database.User).filter_by(user_guid=str(user_id)).first()

        if not user:
            # اگر کاربر در دیتابیس وجود نداشته باشد، اطلاعات او را ذخیره کن
            get_author = update.get_author()
            username = get_author.username
            user = database.User(user_guid=update.author_guid, username=username)
            session.add(user)
            session.commit()

        else:
            if group.lock_authentication is True:
                user_auth = session.query(database.UserAuthentication).filter_by(user_guid=str(user_id)).first()
                if not user_auth:
                    authenticate_user(update)

                number = get_int(update.text)
                if number and update.object_guid == user_auth.group_guid and update.author_guid == user_auth.user_guid:
                    if update.reply_message_id:
                        if number == user_auth.expected_result:
                            session.query(database.UserAuthentication).filter_by(group_guid=update.object_guid, user_guid=update.author_guid).update({"auth": True})
                            update.reply('شما احراز هویت شدید.')

                if user_auth and user_auth.auth is False:
                    update.delete()

@bot.on_message_updates(filters.is_group)
def handle_locks(update: Update):
    group = session.query(database.Group).filter_by(group_guid=update.object_guid).first()

    if group and update.is_admin(user_guid=update.author_guid) is False:
        if update.forwarded_from and group.lock_forward:
            return warn_user(update, session, 'ارسال فوروارد')

        elif update.text:
            if group.lock_text:
                return update.delete()
            elif group.lock_links and LINK_RE.search(update.text):
                return warn_user(update, session, 'ارسال لینک')
            elif group.lock_usernames and utils.is_username(update.text):
                return warn_user(update, session, 'ارسال نام کاربری')
            elif group.lock_hashtags and HASHTAG_RE.search(update.text):
                return update.delete()
            elif update.metadata:
                if group.lock_hyperlinks:
                    for part in update.metadata.meta_data_parts:
                        if part.type == 'Link':
                            return update.delete()

                elif group.lock_command_mention:
                    for part in update.metadata.meta_data_parts:
                        if part.type == 'MentionText':
                            return update.delete()
            elif group.lock_badwords:
                if is_badword(BADWORDS, update.text):
                    update.reply('یک فحش حذف شد.')
                    return warn_user(update, session, 'ارسال فحش')

        elif update.file_inline:
            if group.lock_inline:
                update.delete()
            elif group.lock_files and update.file_inline.type == 'File':
                update.delete()
            elif group.lock_photos and update.file_inline.type == 'Image':
                update.delete()
            elif group.lock_videos and update.file_inline.type == 'Video':
                update.delete()
            elif group.lock_voice_commands and update.file_inline.type == 'Voice':
                update.delete()
            elif group.lock_gifs and update.file_inline.type == 'Gif':
                update.delete()

        elif update.sticker and group.lock_stickers:
            update.delete()

        elif update.location and group.lock_location:
            update.delete()

        elif update.poll and group.lock_polls:
            return update.delete()

        elif update.message.type == 'RubinoStory' and group.lock_story:
            return update.delete()

@bot.on_message_updates(filters.is_group, filters.commands(['status', 'وضعیت']))
def get_status(update: Update) -> None:
    """نمایش وضعیت قفل‌ها در گروه به صورت فارسی"""
    group = session.query(database.Group).filter_by(group_guid=update.object_guid).first()

    if group and update.is_admin(user_guid=update.author_guid):
        status_message = '🔷 **وضعیت قفل ها:**\n\n'
        for attribute_name, lock_name in config.LOCK_TYPES.items():
            lock_status = "✅" if getattr(group, f"lock_{attribute_name}") else "❌"
            status_message += f"• {lock_name}: {lock_status}\n"

        update.reply(status_message, parse_mode=ParseMode.MARKDOWN)

@bot.on_message_updates(filters.is_group, filters.commands('warn'))
def warn_user_by_admin(update: Update):
    group = session.query(database.Group).filter_by(group_guid=update.object_guid).first()
    if group and update.is_admin(user_guid=update.author_guid):
        return HandleWarns(update=update, session=session)

@bot.on_message_updates(filters.is_group, filters.commands(['بن', 'اخراج'], prefixes=''))
def ban_user_by_admin(update: Update):
    user_guid = update.get_messages(message_ids=update.reply_message_id).messages[0].author_object_guid
    info = update.client.get_info(object_guid=user_guid)
    first_name = info["user"].get("first_name", "")
    last_name = info["user"].get("last_name", "")
    full_name = f"{first_name} {last_name}".strip() or "کاربر"


    # full_name = f"{info.get('user', {}).get('first_name', '')} {info.get('user', {}).get('last_name', '')}".strip() or "کاربر"
    mention = f"[{full_name}]({user_guid})"
    group = session.query(database.Group).filter_by(group_guid=update.object_guid).first()

    if group and update.is_admin(user_guid=update.author_guid):
        if update.reply_message_id:
            author_guid = update.get_messages(message_ids=update.reply_message_id).messages[0].author_object_guid

        else:
            author_guid = update.client.get_info(username=update.text.split()[-1]).user_guid

        user = session.query(database.User).filter_by(user_guid=author_guid).first()
        is_admin = session.query(database.GroupAdmin).filter_by(
                group_guid=group.group_guid, user_guid=author_guid
            ).first()
        if author_guid == bot.guid:
            return update.reply("ایشون منم")
        elif is_admin:
            return update.reply("⛔️ این کاربر یکی از ادمین‌های گروه است و نمی‌توان او را بن کرد.")
        elif user:
            banned_user = database.BannedUser(group_guid=update.object_guid, user_guid=author_guid)
            session.add(banned_user)
            update.ban_member(user_guid=author_guid)
            update.reply(f"{mention} توسط ادمین از گروه حذف شد.",
                         parse_mode=ParseMode.MARKDOWN)




@bot.on_message_updates(filters.is_group, filters.commands(['رفع', 'آن‌بن', 'آنبن', 'انبن'], prefixes=''))
def unban_user_by_admin(update: Update):
    user_guid = update.get_messages(message_ids=update.reply_message_id).messages[0].author_object_guid
    info = update.client.get_info(object_guid=user_guid)
    first_name = info["user"].get("first_name", "")
    last_name = info["user"].get("last_name", "")
    full_name = f"{first_name} {last_name}".strip() or "کاربر"
    mention = f"[{full_name}]({user_guid})"
    group = session.query(database.Group).filter_by(group_guid=update.object_guid).first()
    if group and update.is_admin(user_guid=update.author_guid):
        try:
            # حالت ریپلای
            if update.reply_message_id:
                replied_msg = update.get_messages(message_ids=update.reply_message_id).messages[0]
                target_guid = replied_msg.author_object_guid

            # حالت استفاده از یوزرنیم یا آیدی
            else:
                parts = update.text.split()
                if len(parts) < 2:
                    return update.reply("لطفاً آیدی یا یوزرنیم فرد مورد نظر را وارد کنید. مثال:\n`رفع @username`", parse_mode=ParseMode.MARKDOWN)

                identifier = parts[1].lstrip('@')
                user = session.query(database.User).filter(
                    (database.User.username == identifier) | (database.User.user_guid == identifier)
                ).first()

                if not user:
                    return update.reply("کاربر مورد نظر در دیتابیس پیدا نشد.")
                target_guid = user.user_guid

            # بررسی وجود در جدول BannedUser
            banned = session.query(database.BannedUser).filter_by(group_guid=group.group_guid, user_guid=target_guid).first()
            if not banned:
                return update.reply("این کاربر در لیست بن نیست.")

            # حذف از لیست بن
            session.delete(banned)
            session.commit()
            update.unban_member(user_guid=target_guid)
            update.reply(f"✅ {mention} از لیست سیاه گروه خارج شد.")
            # در صورت نیاز: می‌تونی دوباره او را به گروه دعوت کنی اگر دسترسی داری.
            # bot.invite_user(group_guid, target_guid)

        except Exception as e:
            update.reply(f"خطایی رخ داد:\n{e}")


@bot.on_message_updates(filters.object_guids(ADMINS), filters.commands('add'))
def add_group(update: Update):
    preview = bot.group_preview_by_join_link(update.command[-1])

    if not preview.is_valid:
        return update.reply('لینک گروه اشتباهه! 🙁')

    group_guid = preview.group.group_guid
    group_title = preview.group.group_title

    existing_group = session.query(database.Group).filter_by(group_guid=group_guid).first()

    if existing_group:
        return update.reply(f'گروه 「{group_title}」از قبل اضافه شده! 😊')

    else:
        # ایجاد گروه جدید
        bot.join_group(update.command[-1])
        session.add(database.Group(group_guid=group_guid, name=group_title))
        session.commit()
        bot.send_message(
            object_guid=group_guid,
            text='ربات با موفقیت در گروه فعال شد، لطفا حتما ربات را در گروه فول ادمین کنید در غیر اینصورت ربات به درستی کار نمیکند.\nساخته شده توسط حامد',
        )
        return update.reply(f'گروه 「{group_title}」رو اضافه کردم! 😁')

# @bot.on_message_updates(filters.text, filters.is_group)
# async def updates(update: Update):
#     group = session.query(database.Group).filter_by(group_guid=update.object_guid).first()

#     if group:
#         text: str = update.text

#         if text == 'اتمام' and game_data and update.author_guid in game_data.values():
#             game_data.clear()
#             return await update.reply('بازی تمام شد!')

#         elif game_data:
#             if game_data['users_count'] == 2:
#                 number = get_int(text)
#                 if number:
#                     symbol = 'O' if game_data['O'] == update.author_guid else 'X'

#                     if game_data['turn'] == symbol and game_data[symbol] == update.author_guid:
#                         if number in game_data['used']:
#                             return await update.reply('لطفا عدد دیگری انتخاب کنید!')

#                         row = (number - 1) // 3
#                         col = (number - 1) % 3
#                         game_data.get('instance').play_move(row, col, symbol)
#                         game_data['used'].append(number)
#                         winner = game_data['instance'].check_winner()
#                         if winner:
#                             await update.reply_photo(
#                                 photo=game_data['instance'].get_image(),
#                                 caption='کاربر {} برنده شد!'.format(winner),
#                                 file_name=get_filename())
#                             return game_data.clear()

#                         game_data['turn'] = 'O' if symbol == 'X' else 'X'
#                         game_data['round'] = game_data.get('round') + 1

#                         if game_data['round'] == 9:
#                             await update.reply_photo(
#                                 photo=game_data['instance'].get_image(),
#                                 caption='هیچکس برنده نشد، بازی مساوی شد!',
#                                 file_name=get_filename())
#                             return game_data.clear()

#                         if game_data['is_ai'] is True:
#                             symbol = 'O'
#                             ai_move = game_data['instance'].ai.find_best_move(game_data['instance'].board)
#                             game_data['instance'].play_move(*ai_move, symbol=symbol)
#                             game_data['turn'] = 'O' if symbol == 'X' else 'X'
#                             game_data['round'] = game_data.get('round') + 1

#                         winner = game_data['instance'].check_winner()
#                         if winner:
#                             await update.reply_photo(
#                                 photo=game_data['instance'].get_image(),
#                                 caption='کاربر {} برنده شد!'.format(winner),
#                                 file_name=get_filename())
#                             return game_data.clear()

#                         await update.reply_photo(
#                             photo=game_data['instance'].get_image(),
#                             file_name=get_filename(),
#                             caption='حالا {} یک عدد انتخاب کند:'.format('O' if symbol == 'X' else 'X'))

#             if text == 'ورود':
#                 if not update.author_guid in tuple(game_data.values()):
#                     if not game_data['users_count'] == 2:
#                         if game_data['users_count'] in [0, 2]:
#                             game_data['users_count'] = game_data['users_count'] + 1
#                             game_data[symbols.get(game_data['users_count'])] = update.author_guid
#                             await update.reply('🔥 شما وارد بازی شدید\n\nسمبل شما: {}'.format(symbols.get(game_data['users_count'])))

#                         else:
#                             game_data['users_count'] = game_data['users_count'] + 1
#                             game_data[symbols.get(game_data['users_count'])] = update.author_guid

#                             await update.reply('🔥 شما وارد بازی شدید\n\nسمبل شما: {}\n\nیک عدد بین ۱ الی ۹ ارسال کنید:'.format(symbols.get(game_data['users_count'])))

#         elif text.startswith('شروع'):
#             game_data['instance'] = game.TicTacToeGame()
#             game_data['is_ai'] = False
#             game_data['users_count'] = 0
#             game_data['round'] = 0
#             game_data['used'] = []
#             game_data['turn'] = 'X'

#             if text.endswith('بات'):
#                 game_data['is_ai'] = True
#                 game_data['O'] = bot.guid
#                 game_data['X'] = update.author_guid
#                 game_data['users_count'] = 2

#                 ai_move = game_data['instance'].ai.find_best_move(game_data['instance'].board)
#                 game_data['instance'].play_move(*ai_move, symbol='O')
#                 game_data['round'] = game_data.get('round') + 1
#                 return await update.reply_photo(game_data['instance'].get_image(),
#                                                 file_name=get_filename(),
#                                                 caption='🎮 بازی شروع شد\n\n⚡️لطفا یک عدد بین 1 تا 9 بفرستید.')

#             await update.reply_photo(game_data['instance'].get_image(),
#                                      file_name=get_filename(),
#                                      caption='🎮 بازی شروع شد\n\n⚡️برای ورود به بازی کلمه **"ورود"** را ارسال کنید.')

# شروع اجرای کرون جاب
scheduler.start()
# شروع ربات
try:
    bot.run()

except Exception as e:
    print(f'Error: {e}')
