# قرارداد API نسخه ۳

Endpoint همان Supabase Edge Function به نام `rubika-panel` است. تمام عملیات `POST` با `Content-Type: application/json` هستند. پاسخ‌ها Cache نمی‌شوند. هیچ توکن در Query، URL پنل یا Header عمومی قرار نگیرد. این سرویس Cookie، Supabase Auth و مجوز مدیران چندنفره ندارد؛ دارنده توکن معتبر، مالک داده همان ربات است.

پاسخ موفق `{ "ok": true, ... }` و خطا `{ "ok": false, "code": "...", "error": "..." }` است. متن `error` برای خطای شبکه/زیرساخت عمومی است؛ جزئیات داخلی و Token بازگردانده نمی‌شوند. HTTP 400 اعتبارسنجی، 401 اعتبار توکن، 403 مجوز/Origin، 409 تعارض یا عملیات قبلی، 413 اندازه، 429 نرخ، 502 پاسخ روبیکا و 503 تنظیمات/دیتابیس را نشان می‌دهد. حداکثر بدنه ۶۴ KiB و Payload هر Resource برابر ۲۴ KiB است.

## سلامت و ورود

```json
{"action":"health"}
```

بدون توکن. خروجی `service`, `version:"3.1"`, `configured`, `capabilities`, `message_methods`, `live_verified:false`. مقدار `configured` فقط حضور Bindingهای لازم را بیان می‌کند. Capabilityهای engine، manual_engine، moderation، scheduling، automation_execution و reports پشتیبانی کد را نشان می‌دهند. background فقط در پاسخ engine_status و پس از مشاهده lease/heartbeat واقعی فعال می‌شود. Webhook، RBAC، 2FA و Upload کامل همچنان false هستند.

```json
{"action":"login","token":"PRIVATE_TOKEN_IN_MEMORY"}
```

خروجی: `bot:{id,bot_id,name,username}`, `capabilities`, `message_methods`. تمام عملیات زیر هم `token` را در بدنه می‌خواهند و دوباره `getMe` را بررسی می‌کنند.

## گروه‌ها و کانال‌ها؛ سازگار با اکشن‌های قدیمی

| Action | فیلدها | نتیجه |
| --- | --- | --- |
| `list` | — | `groups:[{chat_id,title,type,settings,created_at,updated_at}]` |
| `save` | `chat_id,title,settings,type?` | `group`, `applied:false` |
| `delete` | `chat_id` | `deleted`, `affected` |

`type` برابر `group` یا `channel` است و در صورت نبود، `group` می‌شود. `delete` فقط ثبت گفتگو در پنل را حذف می‌کند؛ گروه یا کانال روبیکا حذف نمی‌شود. `settings` یک Object است؛ با save، قفل‌ها صرفاً ذخیره می‌شوند؛ موتور جداگانه فقط قواعد پشتیبانی‌شده و صریحاً فعال‌شده را اجرا می‌کند. خوشامدگویی عضویت به رویداد API مستند نیاز دارد. شناسه مجاز تنها از حروف لاتین، عدد و `_:−` تشکیل می‌شود؛ به‌جای نشانه Unicode منفی، `-` ASCII استفاده کنید.

```json
{"action":"save","token":"PRIVATE_TOKEN_IN_MEMORY","chat_id":"b0example","title":"گروه نمونه","type":"group","settings":{"active":false,"locks":{"link":true},"warn_limit":3}}
```

## مجموعه‌های پایدار

Collections: `drafts`, `templates`, `automations`, `schedules`, `tickets`, `users`, `violations`, `consents`, `logs`.

| Action | فیلدها | نتیجه |
| --- | --- | --- |
| `collection_list` | `collection,limit?,offset?` | `items:[{id,data,created_at,updated_at}],limit,offset` |
| `collection_save` | `collection,id?,data` | `item`, `executed:false` |
| `collection_delete` | `collection,id` | `deleted`, `affected` |

`id` یک UUID است؛ برای ثبت قابل تکرار از UUID ثابت یک فرم استفاده کنید. در نبود `id` سرور UUID تازه می‌سازد. صفحه‌بندی: `limit` از ۱ تا ۵۰۰، پیش‌فرض ۵۰۰؛ `offset` از ۰ تا ۱۰۰۰۰۰. `data` فقط JSON Object است. Payload نباید توکن فعال یا فیلدهای Credential مانند `botToken`, `api_key`, `access_token`, `password` داشته باشد. `logs` فقط خواندنی و شامل تاریخچه واقعی سرور است؛ ذخیره/حذف آن خطای `AUDIT_READ_ONLY` می‌دهد. در برنامه زمان‌بندی `scheduled_at` یا `scheduledAt` در صورت وجود باید تاریخ ISO معتبر باشد؛ Job ایجاد نمی‌شود.

## عملیات واقعی روبیکا

```json
{"action":"message","token":"PRIVATE_TOKEN_IN_MEMORY","method":"sendMessage","params":{"chat_id":"b0example","text":"پیام آزمایشی"},"authorized":true,"operation_id":"11111111-1111-4111-8111-111111111111"}
```

پاسخ: `result`, `operation_id`, `replayed`. مقصد باید قبلاً با `save` در همین Scope ثبت شده باشد و تأیید صریح `authorized:true` لازم است؛ API روبیکا نیز مجوز واقعی Bot در مقصد را کنترل می‌کند. برای فوروارد، مبدأ و مقصد هر دو باید ثبت شوند. Keyهای ناشناخته از `params` به روبیکا فرستاده نمی‌شوند.

| Method | Params |
| --- | --- |
| `sendMessage` | `chat_id,text,reply_to_message_id?,disable_notification?,inline_keypad?,chat_keypad?,chat_keypad_type?` |
| `sendPoll` | `chat_id,question,options` و فیلدهای اختیاری مشترک ارسال |
| `sendLocation` | `chat_id,latitude,longitude` و فیلدهای اختیاری مشترک |
| `sendContact` | `chat_id,first_name,last_name?,phone_number` و فیلدهای اختیاری مشترک |
| `sendSticker` | `chat_id,sticker_id` و فیلدهای اختیاری مشترک |
| `sendFile` | `chat_id,file_id` و فیلدهای اختیاری مشترک |
| `forwardMessage` | `from_chat_id,to_chat_id,message_id,disable_notification?` |
| `editMessageText` | `chat_id,message_id,text` |
| `deleteMessage` | `chat_id,message_id` |
| `getChat` | `chat_id` |

`getChat` عملیات خواندنی است و UUID لازم ندارد. تمام Mutationها UUID معتبر می‌خواهند. UUID همان ثبت را هنگام خطای شبکه حفظ کنید: پاسخ موفق قبلی بازگردانده می‌شود؛ محتوای متفاوت با همان UUID خطای `OPERATION_CONFLICT` می‌دهد. عملیات `pending`, `unknown` یا `rejected` با همان UUID تکرار نمی‌شود و `OPERATION_ALREADY_ATTEMPTED` همراه `outcome` می‌دهد. موفقیت تأییدنشده هرگز موفق نمایش داده نمی‌شود.

خطاهای پس از شروع عملیات نیز `operation_id` را بازمی‌گردانند. اگر روبیکا عمل را تأیید کند ولی ثبت دیتابیس کامل نشود، کد `OPERATION_RECORDING_INCOMPLETE` و `outcome:"confirmed_unrecorded"` برمی‌گردد؛ ارسال دوباره انجام نشود. اگر ثبت شکست مبهم شبکه نیز انجام نشود، `recording_pending:true` است؛ Claim اولیه همچنان از ارسال مجدد جلوگیری می‌کند.

متن حداکثر ۴۰۹۶ نویسه؛ سؤال نظرسنجی ۳۰۰؛ گزینه‌ها ۲ تا ۱۰ مقدار متمایز، هر یک تا ۱۰۰ نویسه. مختصات در محدوده قانونی. Keypad فقط دکمه `Simple` را می‌پذیرد:

```json
{"rows":[{"buttons":[{"id":"help","type":"Simple","button_text":"راهنما"}]}]}
```

هنگام ارسال `chat_keypad`, مقدار `chat_keypad_type` باید `New` باشد. `sendFile` فقط یک شناسه معتبر موجود را می‌فرستد؛ Upload فایل یا Caption رسانه را ادعا نمی‌کند. متدهای مسدودسازی، سنجاق یا مدیریت اعضا پذیرفته نمی‌شوند.

## دریافت رویداد با درخواست کاربر

```json
{"action":"poll","token":"PRIVATE_TOKEN_IN_MEMORY","limit":25,"offset_id":"OPTIONAL_LAST_OFFSET"}
```

`offset_id` را در درخواست اولیه حذف کنید. `limit` از ۱ تا ۱۰۰ است. پاسخ `updates`, `next_offset_id`, `received_at`, `new_events` دارد. Offset بعدی را فقط پس از پردازش پاسخ موفق به‌روز کنید. مرورگر مجاز است آن را تا پایان نشست در حافظه نگه دارد؛ این API Polling خودکار سرور یا Webhook نیست. رویدادهای تکراری در جدول فراداده با Hash یکتا حذف می‌شوند؛ بازگشت همان Update به مرورگر ممکن است و UI نیز باید بر اساس شناسه رویداد Deduplicate کند. رویداد خام/متن پیام در پایگاه داده جدول رویدادها ذخیره نمی‌شود.

## موتور، نشست و گزارش نسخه ۳٫۱

| Action | ورودی | نتیجه و محدودیت |
|---|---|---|
| `engine_status` | — | runtime، worker_running و capabilities؛ وجود کد، وجود Worker زنده را ثابت نمی‌کند |
| `engine_toggle` | `enabled:boolean` | توقف مستقل همان Scope؛ درخواست درحال‌ارسال بازپس‌گرفته نمی‌شود |
| `engine_run` | `authorized:true,limit?:1..10` | یک نوبت دریافت و پردازش، پیش‌فرض ۵؛ processed، duplicates، actions، errors و next_offset_id |
| `schedule_run` | `authorized:true` | حداکثر ۵ تلاش از برنامه‌های تأییدشدهٔ رسیده، بدون ارسال مجدد نتیجه نامشخص |
| `sessions_list` | — | حداکثر ۱۰۰ نشست دارای رضایت و مهلت معتبر، فقط در Scope مالک توکن |
| `reports` | `from?,to?:ISO,compare?:boolean` | report.summary، daily، by_type، by_command و previous؛ حداکثر بازه ۳۶۶ روز |

همه درخواست‌ها با توکن Bot دوباره احراز می‌شوند. اجرای هم‌زمان روی یک ربات ENGINE_BUSY می‌دهد؛ ربات متوقف ENGINE_PAUSED و شکست ذخیره runtime خطای RUNTIME_STORE_UNAVAILABLE دارد. عملیات موتور می‌تواند بیش از timeout مرورگر طول بکشد؛ ادعای رویداد/عملیات پیش از ارسال ثبت می‌شود و تلاش مبهم خودکار تکرار نمی‌شود.

مجموعه‌های جدید: commands، faq، flows، menus، subscribers. مشترک‌های فعال باید enabled=true، authorized=true، status=approved و allowed_chat_ids ثبت‌شده داشته باشند. commands به match=command و faq به keyword تبدیل می‌شود. flow مراحل دارای id/key یکتا، prompt و validation از text/number/email/choice دارد؛ choice دو تا هشت گزینه یکتا دارد. منو حداکثر چهار سطح و صد گزینه یکتا دارد. subscribers از API عمومی فقط خواندنی است؛ /subscribe و /unsubscribe وضعیت رضایت همان فرستنده را تغییر می‌دهند. این رضایت، مجوز ارسال ناخواسته عمومی نمی‌سازد.

گزارش بازه‌های نیمه‌باز و زمان تهران را استفاده می‌کند. اعداد بر اساس حداکثر ۵۰۰۰ رویداد و ۵۰۰ سابقهٔ بازگشتی‌اند؛ truncated و audit_limit حدود آن را نشان می‌دهند. member_count یا نوع رسانه نامستند ساخته نمی‌شود.
