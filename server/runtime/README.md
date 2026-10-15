# اجرای خصوصی پردازشگر JavaScript

فرانت‌اند همچنان HTML/CSS/JavaScript و قابل انتشار در GitHub Pages است. اجرای دائمی زمان‌بندی و دریافت پیام‌ها به یک پردازشگر خصوصی Node.js و Supabase نیاز دارد؛ GitHub Pages این پردازشگر را اجرا نمی‌کند. هیچ وابستگی npm یا Python لازم نیست.

## پیش‌نیاز و تنظیمات

ابتدا Migrationهای `server/supabase/migrations` را به ترتیب طبق [راهنمای سرور](../README.md) روی پروژه آزمایشی اعمال و تابع `rubika-panel` را مستقر کنید. پردازشگر و تابع باید از **همان پروژه و همان `SCOPE_SALT` پایدار** استفاده کنند. تغییر Salt محدوده داده‌های ربات را عوض می‌کند.

فایل خصوصی خارج از checkout و خارج از پوشه عمومی سایت بسازید؛ دسترسی آن را به مالک محدود کنید. مقادیر زیر فقط نام/جای‌نگهدار هستند و باید در محیط خصوصی تکمیل شوند:

```dotenv
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_PRIVATE_SERVICE_ROLE_KEY
SCOPE_SALT=YOUR_STABLE_RANDOM_SECRET_AT_LEAST_32_CHARACTERS
BOT_TOKEN=YOUR_REAL_RUBIKA_BOT_TOKEN
WORKER_POLL_INTERVAL_MS=5000
WORKER_BATCH_LIMIT=5
```

کلید سرویس و توکن فقط به worker داده می‌شوند؛ آنها را در JavaScript مرورگر، GitHub Pages، مخزن، دستور build یا خروجی عمومی لاگ قرار ندهید. از چاپ `docker compose config` همراه فایل اسرار خودداری کنید؛ برای بررسی ساختار از `config --quiet` استفاده کنید. مدیر Docker می‌تواند متغیرهای کانتینر را ببیند؛ میزبان باید خصوصی باشد.

## Docker Compose

از ریشه مخزن، برای نمایش عمومی بدون هیچ اعتبارنامه‌ای:

```bash
docker compose config --quiet
docker compose up -d --build web
# http://127.0.0.1:4173/rubika_bot/
```

سرویس web فقط فایل‌های عمومی مجاز را داخل image دارد؛ هیچ پوشه‌ای از میزبان روی آن mount نمی‌شود. پردازش‌ها non-root و فایل‌سیستم read-only هستند. پورت پیش‌فرض فقط روی loopback منتشر می‌شود؛ برای دسترسی عمومی از reverse proxy دارای HTTPS استفاده کنید. `WEB_PORT` پورت میزبان را تغییر می‌دهد.

پس از تنظیم فایل خصوصی واقعی، worker را آگاهانه فعال کنید؛ فعال‌شدن آن می‌تواند پیام ارسال یا حذف کند و برنامه‌های ذخیره‌شده را اجرا کند:

```bash
chmod 600 /path/outside-checkout/rubika-worker.env
docker compose --env-file /path/outside-checkout/rubika-worker.env --profile worker config --quiet
docker compose --env-file /path/outside-checkout/rubika-worker.env --profile worker up -d --build
docker compose --profile worker ps
docker compose --profile worker logs --tail=50 worker
```

worker پورت HTTP ندارد و برای هر ربات باید تنها یک poller فعال باشد؛ lease دیتابیس از پردازش هم‌زمان نمونه‌های این worker جلوگیری می‌کند، اما یک poller خارجی را کنترل نمی‌کند. دریافت دستی `getUpdates` از پنل را هم‌زمان با worker فعال نکنید. برای چند ربات، هر worker باید فایل خصوصی و نام پروژه Compose جداگانه داشته باشد؛ web را می‌توان مشترک نگه داشت.

توقف ربات از پنل فقط همان ربات را متوقف می‌کند؛ worker در حالت توقف ضربان سلامت را ادامه می‌دهد و رویداد تازه یا پیام بعدی را اجرا نمی‌کند. عملیاتی که پیش‌تر به روبیکا ارسال شده قابل بازپس‌گیری نیست. نشست فرم پس از حداکثر ۱۵ دقیقه از دسترس خارج می‌شود؛ worker فعال و خواندن/ذخیره/فهرست نشست‌ها رکوردهای منقضی را از دیتابیس هم پاک می‌کنند. اگر worker و دسترسی به سرویس هر دو متوقف باشند، پاک‌سازی فیزیکی با اجرای بعدی انجام می‌شود.

پس از ثبت نخستین اجرای یک برنامه، شناسه آن به تنظیمات همان نسخه متصل می‌ماند. برای تغییر محتوا، مقصد یا زمان‌بندیِ برنامه‌ای که سابقه اجرا دارد، برنامه قبلی را متوقف و نسخه جدید با شناسه جدید بسازید؛ تاریخچه اجرای قبلی را برای ارسال دوباره پاک نکنید.

برای توقف worker بدون حذف داده‌ها:

```bash
docker compose --profile worker stop worker
```

image رسمی Node 24 Alpine با digest چندمعماری Docker Hub pin شده است. هنگام به‌روزرسانی، digest جدید را از رجیستری رسمی بررسی و هر دو target را دوباره بسازید؛ TLS و بررسی digest را غیرفعال نکنید.

## اجرای مستقیم

Node.js 24 یا بالاتر نصب کنید. متغیرها باید تنها به فرآیند خصوصی worker تزریق شوند؛ فرمان Node فایل env را بدون اجرای shell می‌خواند:

```bash
node --env-file=/path/outside-checkout/rubika-worker.env server/runtime/worker.js
# بررسی سلامت worker در حال اجرا، بدون راه‌اندازی poller دوم:
node --env-file=/path/outside-checkout/rubika-worker.env server/runtime/worker.js --healthcheck
```

در میزبان دائمی از مدیر سرویس دارای restart و محدودسازی دسترسی استفاده کنید. شکست مبهم عملیات به‌طور خودکار دوباره ارسال نمی‌شود؛ وضعیت `unknown` را پیش از ساخت UUID جدید در مقصد بررسی کنید. `SIGTERM`/`SIGINT` دریافت جدید را متوقف و lease را پس از پایان کار جاری آزاد می‌کنند.

## اعتبارسنجی

بدون اعتبارنامه می‌توان imageها را build کرد، web را راه انداخت و تست‌های مخزن را اجرا کرد. سلامت worker به دسترسی خواندنی به روبیکا و وضعیت lease/heartbeat واقعی در دیتابیس وابسته است. اجرای زنده با توکن واقعی، اعمال Migration روی پروژه کاربر و ارسال یا حذف واقعی پیام در محیط توسعه انجام نشده‌اند؛ پیش از استفاده عمومی، آنها را در گروه آزمایشی دارای مجوز بررسی کنید. موفقیت تست‌های mock یا کانتینر web، تأیید اجرای زنده روبیکا نیست.
