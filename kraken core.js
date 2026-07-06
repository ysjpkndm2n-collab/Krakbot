/**
 * ═══════════════════════════════════════════════════════════════════════════
 * KRAKEN Workflow — Telegram-бот для автодетейлинга (учёт работ, ЗП, кассы).
 * Оригинал написан на Google Apps Script, ПОРТИРОВАН на Node.js.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ┌─ КОНТЕКСТ ДЛЯ НЕЙРОСЕТИ (читай перед правками) ──────────────────────────┐
 *
 * ЧТО ЭТО. Бот ведёт автомойку/детейлинг: приёмщики принимают машины,
 * мастера берут их в работу поэтапно, бот считает зарплату за этапы,
 * ведёт кассу (нал/безнал), смены сотрудников, геолокацию прихода,
 * доступы подрядчиков, фото до/после. Данные — в Google Sheets.
 *
 * АРХИТЕКТУРА ПОРТА (важно!):
 *  - Этот файл = ЧИСТАЯ ЛОГИКА бота. Он НЕ работает сам по себе.
 *  - Он экспортирует фабрику createKraken(env). В env приходят ЭМУЛЯТОРЫ
 *    Google-Apps-Script API (SpreadsheetApp, DriveApp, Utilities и т.д.),
 *    сделанные в соседних файлах:
 *        src/gas-shim.js   — эмуляция Sheets/Properties/Utilities/... (см. там)
 *        src/drive-shim.js — DriveApp/DocumentApp через Drive REST (фото, PDF)
 *        src/urlfetch.js   — UrlFetchApp через синхронный curl
 *        src/google.js     — реальный клиент googleapis (сервисный аккаунт)
 *        src/index.js      — ТОЧКА ВХОДА: long polling Telegram + фон.задачи + flush
 *  - Поэтому код тут ВЫГЛЯДИТ как GAS (SpreadsheetApp.openById и т.п.),
 *    но реально бьёт по эмуляторам. НЕ переписывай на googleapis напрямую.
 *
 * МОДЕЛЬ РАБОТЫ С ТАБЛИЦЕЙ (критично для понимания):
 *  - index.js перед каждым апдейтом грузит ВСЕ листы в память (loadAll).
 *  - Весь код тут СИНХРОННЫЙ: getValues() читает из кэша, setValue/appendRow
 *    пишут в кэш и метят лист "dirty".
 *  - После обработки index.js делает flushAll() — сбрасывает изменения в Sheets
 *    одним batch-запросом. SpreadsheetApp.flush() тут — ПУСТЫШКА (реальный
 *    flush в index.js). Не рассчитывай, что flush() что-то шлёт немедленно.
 *  - Значит: НЕ читай лист повторно ожидая увидеть чужую свежую запись в
 *    рамках одного апдейта из другого процесса — кэш замораживается на входе.
 *
 * ТОЧКИ ВХОДА (их дёргает index.js):
 *    onMessage(msg)      — входящее сообщение Telegram (текст/фото/гео/PIN)
 *    onCallback(q)       — нажатие inline-кнопки (routeCallback — главный роутер)
 *    sanitarTick()       — раз/мин: чинит зависшие машины, авто-закрытие смен
 *    idleCheckTick()     — раз/мин: пинги простаивающим
 *    syncQueueTick()     — раз/5мин: читает PDF-протоколы из Drive → лист "Авто"
 *    flushPhotoQueue()   — заливает фото из очереди в Drive
 *    dailyReportTick()   — сводка за день админу (index.js зовёт в 23:00)
 *
 * ОТЛИЧИЯ ОТ ОРИГИНАЛА GAS (уже применены, не "чини" обратно):
 *  - Webhook → long polling. doPost/doGet/SETUP_WEBHOOK не используются.
 *  - watchdogWebhook() — сделан ПУСТЫМ (при polling вебхука нет).
 *  - INSTALL_* функции (триггеры) не нужны: index.js сам ставит setInterval.
 *  - PropertiesService пишет в data/props.json (не в GAS-хранилище).
 *  - Время: VPS в UTC, сдвиг в Utilities.formatDate через TZ_OFFSET_MIN (.env).
 *
 * GOOGLE SHEETS — ЛИСТЫ И КОЛОНКИ (1-based индексы):
 *    "Настройки":  ключ | значение   (cfg("КЛЮЧ") читает отсюда)
 *    "Персонал":   PIN | Имя | telegram | роль | право_выдачи | active | старт_зп
 *                  роли: "админ"|"приёмщик"|"подрядчик"|мастер. См. rowToUser().
 *    "Авто":       колонки описаны в const A = {ID:1, PLATE:2, ...CREATED:14}
 *                  статусы: "в очереди"|"в работе"|"готова к выдаче"|"выдана"
 *    "Логи":       журнал закрытых этапов (когда|carId|плейт|мастер|этап|план|
 *                  старт|финиш|минут|оплата|примечание) — основа расчёта ЗП
 *    "Смены":      события прихода/ухода мастеров
 *    "КассаНал"/"Безнал"/"Фирма": деньги. "Выплаты": выданная ЗП.
 *    "Доступы":    подряд. "Фото": до/после (когда|машина|тип|кто|ссылка|статус)
 *    "Удалённые"/"Ошибки"/"Корректировки": служебные.
 *
 * КЛЮЧЕВАЯ ДОМЕННАЯ ЛОГИКА:
 *    CHAIN — обязательная цепочка этапов полировки (по порядку).
 *    WASH_SERVICE ("Мойка (вся услуга)") — самостоятельный этап, закрывает
 *      машину в одиночку (не входит в CHAIN).
 *    Машина "готова к выдаче" когда: этап==мойка ИЛИ пройдены все этапы CHAIN.
 *    calcPay() — расчёт оплаты за этап (фикс/процент, из листа "Ставки").
 *    ФОТО ДО/ПОСЛЕ ОБЯЗАТЕЛЬНЫ: см. hasPhoto() и проверки в startStage()
 *      (фото "до" перед первым этапом) и finishStage() (фото "после" перед
 *      финалом машины). Фото копятся в лист "Фото" сразу, в Drive — фоном.
 *
 * ГДЕ ЛЕЖАТ ФОТО: Drive, папка DRIVE_FOLDER_ID → подпапка с ID машины
 *    (getOrderFolder). Ссылка дублируется в лист "Фото".
 *
 * ПРИ ПРАВКАХ: меняй только логику. После правки — `pm2 restart kraken`.
 *    Проверка синтаксиса: `node -c src/kraken.core.js`.
 * └──────────────────────────────────────────────────────────────────────────┘
 */

module.exports = function createKraken(env) {
  const {
    SpreadsheetApp, PropertiesService, Utilities, Session, Logger,
    LockService, ScriptApp, HtmlService, UrlFetchApp, DriveApp, DocumentApp,
    __SHEET_ID__, __DRIVE_TOKEN__, __PULL_FROM_GOOGLE__,
  } = env;

const SHEET_ID = __SHEET_ID__;  // задаётся из .env через index.js

// ═══ СПРАВОЧНИК УСЛУГ (автогенерация из протокола kraken_protokol_v3 + services.json) ═══
// Ключ = код услуги из протокола (колонка Kod в PDF). Значение = названия + этапы с чеклистами.
const SERVICES = {
  "MYJ-STD-OS": {
    "name_ua": "STANDARD комплект",
    "name_pl": "STANDARD Detail (osobowy)",
    "stages": [
      {
        "stage": "Мийка кузова + сушка",
        "checklist": [
          "Кузов вимитий",
          "Турбосушка, без крапель"
        ]
      },
      {
        "stage": "Салон + багажник",
        "checklist": [
          "Салон пропилососений",
          "Багажник, дефлектори, килимки чисті"
        ]
      },
      {
        "stage": "Пластик",
        "checklist": [
          "Пластик оброблено"
        ]
      }
    ]
  },
  "MYJ-STD-SUV": {
    "name_ua": "STANDARD комплект (SUV)",
    "name_pl": "STANDARD Detail (SUV)",
    "stages": [
      {
        "stage": "Мийка кузова + сушка",
        "checklist": [
          "Кузов вимитий",
          "Турбосушка, без крапель"
        ]
      },
      {
        "stage": "Салон + багажник",
        "checklist": [
          "Салон пропилососений",
          "Багажник, дефлектори, килимки чисті"
        ]
      },
      {
        "stage": "Пластик",
        "checklist": [
          "Пластик оброблено"
        ]
      }
    ]
  },
  "MYJ-PLUS-OS": {
    "name_ua": "КОМПЛЕКТ PLUS",
    "name_pl": "Detail PLUS (osobowy)",
    "stages": [
      {
        "stage": "Екстер'єр: мийка + колеса",
        "checklist": [
          "Кузов вимитий, турбосушка",
          "Арки очищені",
          "Диски очищені, шини оброблені"
        ]
      },
      {
        "stage": "Інтер'єр",
        "checklist": [
          "Салон пилосос + повітря",
          "Килимки і ковролін чисті"
        ]
      },
      {
        "stage": "Фінішний детайлер",
        "checklist": [
          "Кузов оброблено детайлером, блиск"
        ]
      }
    ]
  },
  "MYJ-PLUS-SUV": {
    "name_ua": "КОМПЛЕКТ PLUS (SUV)",
    "name_pl": "Detail PLUS (SUV)",
    "stages": [
      {
        "stage": "Екстер'єр: мийка + колеса",
        "checklist": [
          "Кузов вимитий, турбосушка",
          "Арки очищені",
          "Диски очищені, шини оброблені"
        ]
      },
      {
        "stage": "Інтер'єр",
        "checklist": [
          "Салон пилосос + повітря",
          "Килимки і ковролін чисті"
        ]
      },
      {
        "stage": "Фінішний детайлер",
        "checklist": [
          "Кузов оброблено детайлером, блиск"
        ]
      }
    ]
  },
  "MYJ-MAX-OS": {
    "name_ua": "КОМПЛЕКТ MAX",
    "name_pl": "detail MAX (osobowy)",
    "stages": [
      {
        "stage": "Екстер'єр: мийка + деконтамінація",
        "checklist": [
          "Ручна мийка + турбосушка",
          "Арки і диски (3 етапи)",
          "Деконтамінація кузова"
        ]
      },
      {
        "stage": "Інтер'єр глибокий",
        "checklist": [
          "Пилосос салону+багажника",
          "Пластик очищено і захищено",
          "Килимки (2 етапи), скло зсередини"
        ]
      },
      {
        "stage": "Захист сидінь + фініш",
        "checklist": [
          "Сидіння оброблено від бруду/UV",
          "Фінальний огляд"
        ]
      }
    ]
  },
  "MYJ-MAX-SUV": {
    "name_ua": "КОМПЛЕКТ MAX (SUV)",
    "name_pl": "detail MAX (SUV)",
    "stages": [
      {
        "stage": "Екстер'єр: мийка + деконтамінація",
        "checklist": [
          "Ручна мийка + турбосушка",
          "Арки і диски (3 етапи)",
          "Деконтамінація кузова"
        ]
      },
      {
        "stage": "Інтер'єр глибокий",
        "checklist": [
          "Пилосос салону+багажника",
          "Пластик очищено і захищено",
          "Килимки (2 етапи), скло зсередини"
        ]
      },
      {
        "stage": "Захист сидінь + фініш",
        "checklist": [
          "Сидіння оброблено від бруду/UV",
          "Фінальний огляд"
        ]
      }
    ]
  },
  "MYJ-ZEW": {
    "name_ua": "STANDARD зовні",
    "name_pl": "STANDARD zewnątrz",
    "stages": [
      {
        "stage": "Детейлінг мийка кузова",
        "checklist": [
          "Кузов вимитий детейлінг-методом",
          "Турбосушка, без крапель"
        ]
      }
    ]
  },
  "MYJ-PROMO": {
    "name_ua": "ПРЕМІУМ пакет «АВТО ЯК НОВЕ»",
    "name_pl": "PREMIUM PROMO",
    "stages": [
      {
        "stage": "Мийка кузова + колеса",
        "checklist": [
          "Кузов вимитий",
          "Диски і арки чисті"
        ]
      },
      {
        "stage": "Захист (антидощ + віск)",
        "checklist": [
          "Антидощ на скло",
          "Віск, блиск, вода скочується"
        ]
      },
      {
        "stage": "Салон + скло",
        "checklist": [
          "Салон пропилососений",
          "Пластик оброблено, скло чисте"
        ]
      }
    ]
  },
  "DET-POL-LEK": {
    "name_ua": "Легке полірування",
    "name_pl": "Polerowanie lekkie regen.",
    "stages": [
      {
        "stage": "Підготовка",
        "checklist": [
          "Кузов вимитий і знежирений",
          "Дефекти відмічені (фото ДО)"
        ]
      },
      {
        "stage": "Легке полірування",
        "checklist": [
          "Подряпини усунені, блиск (фото ПІСЛЯ)"
        ]
      },
      {
        "stage": "Фініш",
        "checklist": [
          "Залишки пасти прибрані"
        ]
      }
    ]
  },
  "DET-POL-GLB": {
    "name_ua": "Глибоке полірування",
    "name_pl": "Polerowanie głębokie",
    "stages": [
      {
        "stage": "Підготовка",
        "checklist": [
          "Кузов вимитий і знежирений",
          "Глибокі дефекти відмічені (фото ДО)"
        ]
      },
      {
        "stage": "Глибоке полірування",
        "checklist": [
          "Множинні проходи, дефекти усунені",
          "Дзеркальний блиск (фото ПІСЛЯ)"
        ]
      },
      {
        "stage": "Фініш + захист",
        "checklist": [
          "Залишки прибрані",
          "Захист нанесено"
        ]
      }
    ]
  },
  "DET-POL-2ET": {
    "name_ua": "Двоетапне полірування",
    "name_pl": "Polerowanie dwuetapowe",
    "stages": [
      {
        "stage": "Підготовка",
        "checklist": [
          "Кузов вимитий і знежирений",
          "Дефекти відмічені (фото ДО)"
        ]
      },
      {
        "stage": "Двоетапне полірування",
        "checklist": [
          "1 етап: дефекти усунені",
          "2 етап: дзеркальний блиск (фото ПІСЛЯ)"
        ]
      },
      {
        "stage": "Фініш + захист",
        "checklist": [
          "Залишки прибрані",
          "Захист нанесено"
        ]
      }
    ]
  },
  "DET-DEKONT": {
    "name_ua": "Деконтамінація",
    "name_pl": "Dekontaminacja karoserii",
    "stages": [
      {
        "stage": "Мийка + деконтамінація",
        "checklist": [
          "Кузов вимитий",
          "Бітум/пил/сіль видалені",
          "Кузов гладкий на дотик"
        ]
      },
      {
        "stage": "Захисна обробка",
        "checklist": [
          "Захист нанесено"
        ]
      }
    ]
  },
  "DET-CERM-EXP": {
    "name_ua": "Кераміка експрес",
    "name_pl": "CERAMIC EXPRESS DETAIL",
    "stages": [
      {
        "stage": "Підготовка поверхні",
        "checklist": [
          "Поверхня вимита і знежирена (фото ДО)"
        ]
      },
      {
        "stage": "Нанесення кераміки",
        "checklist": [
          "Кераміку нанесено рівномірно",
          "Розтяжка, без плям (фото ПІСЛЯ)"
        ]
      }
    ]
  },
  "DET-CER-LAK": {
    "name_ua": "Керамічне покриття кузова",
    "name_pl": "Ceramika na lakier",
    "stages": [
      {
        "stage": "Підготовка (мийка+деконтамінація)",
        "checklist": [
          "Кузов вимитий і знежирений",
          "Деконтамінація (фото ДО)"
        ]
      },
      {
        "stage": "Полірування під кераміку",
        "checklist": [
          "Дефекти усунені",
          "Поверхня готова"
        ]
      },
      {
        "stage": "Нанесення кераміки",
        "checklist": [
          "Кераміка нанесена рівномірно",
          "Розтяжка виконана",
          "Блиск і гідрофоб (фото ПІСЛЯ)"
        ]
      }
    ]
  },
  "DET-CER-PLA": {
    "name_ua": "Кераміка на пластик",
    "name_pl": "Ceramika na plastiki",
    "stages": [
      {
        "stage": "Підготовка поверхні",
        "checklist": [
          "Поверхня вимита і знежирена (фото ДО)"
        ]
      },
      {
        "stage": "Нанесення кераміки",
        "checklist": [
          "Кераміку нанесено рівномірно",
          "Розтяжка, без плям (фото ПІСЛЯ)"
        ]
      }
    ]
  },
  "DET-CER-SZY": {
    "name_ua": "Кераміка на скло",
    "name_pl": "Ceramika na szyby",
    "stages": [
      {
        "stage": "Підготовка поверхні",
        "checklist": [
          "Поверхня вимита і знежирена (фото ДО)"
        ]
      },
      {
        "stage": "Нанесення кераміки",
        "checklist": [
          "Кераміку нанесено рівномірно",
          "Розтяжка, без плям (фото ПІСЛЯ)"
        ]
      }
    ]
  },
  "DET-CER-SKO": {
    "name_ua": "Кераміка на шкіру",
    "name_pl": "Ceramika na skórę",
    "stages": [
      {
        "stage": "Підготовка поверхні",
        "checklist": [
          "Поверхня вимита і знежирена (фото ДО)"
        ]
      },
      {
        "stage": "Нанесення кераміки",
        "checklist": [
          "Кераміку нанесено рівномірно",
          "Розтяжка, без плям (фото ПІСЛЯ)"
        ]
      }
    ]
  },
  "DET-CER-FEL": {
    "name_ua": "Кераміка на диски",
    "name_pl": "Ceramika na felgi",
    "stages": [
      {
        "stage": "Підготовка поверхні",
        "checklist": [
          "Поверхня вимита і знежирена (фото ДО)"
        ]
      },
      {
        "stage": "Нанесення кераміки",
        "checklist": [
          "Кераміку нанесено рівномірно",
          "Розтяжка, без плям (фото ПІСЛЯ)"
        ]
      }
    ]
  },
  "DET-WOSK-TW": {
    "name_ua": "Преміум віск",
    "name_pl": "Premium twardy wosk",
    "stages": [
      {
        "stage": "Підготовка кузова",
        "checklist": [
          "Кузов вимитий і сухий"
        ]
      },
      {
        "stage": "Нанесення воску",
        "checklist": [
          "Віск нанесено рівномірно",
          "Блиск, вода скочується (тест)"
        ]
      }
    ]
  },
  "DET-WOSK-TEF": {
    "name_ua": "Тефлоновий віск",
    "name_pl": "Wosk teflonowy",
    "stages": [
      {
        "stage": "Підготовка кузова",
        "checklist": [
          "Кузов вимитий і сухий"
        ]
      },
      {
        "stage": "Нанесення воску",
        "checklist": [
          "Віск нанесено рівномірно",
          "Блиск, вода скочується (тест)"
        ]
      }
    ]
  },
  "DET-HYDRO": {
    "name_ua": "Гідровіск",
    "name_pl": "Hydrowosk",
    "stages": [
      {
        "stage": "Нанесення",
        "checklist": [
          "Кузов підготовлено",
          "Засіб нанесено, блиск (фото ПІСЛЯ)"
        ]
      }
    ]
  },
  "DET-QUICK": {
    "name_ua": "Quick Detailer",
    "name_pl": "Quick Detailer",
    "stages": [
      {
        "stage": "Нанесення",
        "checklist": [
          "Кузов підготовлено",
          "Засіб нанесено, блиск (фото ПІСЛЯ)"
        ]
      }
    ]
  },
  "DET-ANTID": {
    "name_ua": "Антидощ",
    "name_pl": "Niewidzialna wycieraczka",
    "stages": [
      {
        "stage": "Підготовка скла",
        "checklist": [
          "Скло і дзеркала вимиті/знежирені"
        ]
      },
      {
        "stage": "Нанесення антидощу",
        "checklist": [
          "Покриття на скло і дзеркала",
          "Вода скочується (тест)"
        ]
      }
    ]
  },
  "DET-NAKL": {
    "name_ua": "Зняття наклейок",
    "name_pl": "Usuwanie naklejek",
    "stages": [
      {
        "stage": "Видалення наклейок",
        "checklist": [
          "Наклейки видалені",
          "Клей прибрано, поверхня чиста (фото ПІСЛЯ)"
        ]
      }
    ]
  },
  "DET-WNE-FOT": {
    "name_ua": "Прання сидіння",
    "name_pl": "Pranie tapicerki (fotel)",
    "stages": [
      {
        "stage": "Прання",
        "checklist": [
          "Оброблено засобом (фото ДО)",
          "Плями видалені, висушено (фото ПІСЛЯ)"
        ]
      }
    ]
  },
  "DET-WNE-KAN": {
    "name_ua": "Прання дивана",
    "name_pl": "Pranie kanapy tylnej",
    "stages": [
      {
        "stage": "Прання",
        "checklist": [
          "Оброблено засобом (фото ДО)",
          "Плями видалені, висушено (фото ПІСЛЯ)"
        ]
      }
    ]
  },
  "DET-WNE-DYW": {
    "name_ua": "Прання килимків",
    "name_pl": "Pranie dywaników",
    "stages": [
      {
        "stage": "Прання",
        "checklist": [
          "Оброблено засобом (фото ДО)",
          "Плями видалені, висушено (фото ПІСЛЯ)"
        ]
      }
    ]
  },
  "DET-WNE-SKO": {
    "name_ua": "Чистка шкіри",
    "name_pl": "Czyszczenie chem. skóry",
    "stages": [
      {
        "stage": "Чистка шкіри",
        "checklist": [
          "Плями і жир видалені (фото ДО)",
          "Запах усунено"
        ]
      },
      {
        "stage": "Живлення + захист",
        "checklist": [
          "Кондиціонер нанесено",
          "Захист від UV (фото ПІСЛЯ)"
        ]
      }
    ]
  },
  "DET-WNE-FUL": {
    "name_ua": "Хімчистка всього салону",
    "name_pl": "Czyszczenie całego wnętrza",
    "stages": [
      {
        "stage": "Хімчистка тканини і сидінь",
        "checklist": [
          "Обшивка і сидіння очищені (фото ДО)",
          "Килимки очищені"
        ]
      },
      {
        "stage": "Пластик + скло",
        "checklist": [
          "Пластик і панель очищені",
          "Скло вимито, запах усунено (фото ПІСЛЯ)"
        ]
      }
    ]
  },
  "DET-WNE-DEM": {
    "name_ua": "Чистка з демонтажем сидінь",
    "name_pl": "Wnętrze z demontażem foteli",
    "stages": [
      {
        "stage": "Демонтаж сидінь",
        "checklist": [
          "Сидіння демонтовані (фото)"
        ]
      },
      {
        "stage": "Глибока чистка",
        "checklist": [
          "Обшивка очищена від плям/запаху",
          "Пластик відновлено",
          "Місця під сидіннями, скло"
        ]
      },
      {
        "stage": "Монтаж + фініш",
        "checklist": [
          "Сидіння встановлені",
          "Фінальний огляд"
        ]
      }
    ]
  },
  "DET-OZON": {
    "name_ua": "Озонування",
    "name_pl": "Ozonowanie pojazdu",
    "stages": [
      {
        "stage": "Озонування",
        "checklist": [
          "Апарат встановлено (фото)",
          "Цикл завершено",
          "Салон провітрено, запах свіжий"
        ]
      }
    ]
  },
  "OKL-BASIC": {
    "name_ua": "Оклейка Basic",
    "name_pl": "PPF Basic",
    "stages": [
      {
        "stage": "Підготовка поверхонь",
        "checklist": [
          "Зони вимиті і знежирені (фото ДО)"
        ]
      },
      {
        "stage": "Оклейка",
        "checklist": [
          "Плівку нанесено на зони",
          "Без бульбашок і задирів (фото ПІСЛЯ)"
        ]
      }
    ]
  },
  "OKL-FRONT": {
    "name_ua": "PPF повний перед",
    "name_pl": "PPF Full Front",
    "stages": [
      {
        "stage": "Підготовка поверхонь",
        "checklist": [
          "Зони вимиті і знежирені (фото ДО)"
        ]
      },
      {
        "stage": "Оклейка",
        "checklist": [
          "Плівку нанесено на зони",
          "Без бульбашок і задирів (фото ПІСЛЯ)"
        ]
      }
    ]
  },
  "OKL-FULLBODY": {
    "name_ua": "PPF Full Body",
    "name_pl": "PPF Full Body",
    "stages": [
      {
        "stage": "Підготовка поверхонь",
        "checklist": [
          "Зони вимиті і знежирені (фото ДО)"
        ]
      },
      {
        "stage": "Оклейка",
        "checklist": [
          "Плівку нанесено на зони",
          "Без бульбашок і задирів (фото ПІСЛЯ)"
        ]
      }
    ]
  },
  "OKL-PPF-WNE": {
    "name_ua": "PPF салон",
    "name_pl": "PPF Wnętrze",
    "stages": [
      {
        "stage": "Підготовка поверхонь",
        "checklist": [
          "Зони вимиті і знежирені (фото ДО)"
        ]
      },
      {
        "stage": "Оклейка",
        "checklist": [
          "Плівку нанесено на зони",
          "Без бульбашок і задирів (фото ПІСЛЯ)"
        ]
      }
    ]
  },
  "OKL-TINT": {
    "name_ua": "Тонування скла",
    "name_pl": "Przyciemnienie szyb",
    "stages": [
      {
        "stage": "Підготовка скла",
        "checklist": [
          "Скло вимито зсередини"
        ]
      },
      {
        "stage": "Тонування",
        "checklist": [
          "Плівку нанесено",
          "Без бульбашок (фото ПІСЛЯ)"
        ]
      }
    ]
  },
  "OKL-KOL-WNE": {
    "name_ua": "Зміна кольору (з нішами)",
    "name_pl": "Zmiana koloru (z wnękami)",
    "stages": [
      {
        "stage": "Підготовка кузова",
        "checklist": [
          "Кузов вимитий і знежирений (фото ДО)"
        ]
      },
      {
        "stage": "Зміна кольору",
        "checklist": [
          "Плівку нанесено на панелі",
          "Стики і краї оброблені"
        ]
      },
      {
        "stage": "Фініш",
        "checklist": [
          "Без бульбашок, край підгорнуто (фото ПІСЛЯ)"
        ]
      }
    ]
  },
  "OKL-KOL-BEZ": {
    "name_ua": "Зміна кольору",
    "name_pl": "Zmiana koloru (bez wnęk)",
    "stages": [
      {
        "stage": "Підготовка кузова",
        "checklist": [
          "Кузов вимитий і знежирений (фото ДО)"
        ]
      },
      {
        "stage": "Зміна кольору",
        "checklist": [
          "Плівку нанесено на панелі",
          "Стики і краї оброблені"
        ]
      },
      {
        "stage": "Фініш",
        "checklist": [
          "Без бульбашок, край підгорнуто (фото ПІСЛЯ)"
        ]
      }
    ]
  },
  "OKL-DECHROM": {
    "name_ua": "Dechroming",
    "name_pl": "Dechroming",
    "stages": [
      {
        "stage": "Підготовка",
        "checklist": [
          "Хром вимитий і знежирений (фото ДО)"
        ]
      },
      {
        "stage": "Dechroming",
        "checklist": [
          "Хром оклеєно/зафарбовано",
          "Рівномірно, без задирів (фото ПІСЛЯ)"
        ]
      }
    ]
  },
  "OKL-INDYW": {
    "name_ua": "Індивідуальний PPF",
    "name_pl": "Indywidualny pakiet PPF",
    "stages": [
      {
        "stage": "Підготовка поверхонь",
        "checklist": [
          "Зони вимиті і знежирені (фото ДО)"
        ]
      },
      {
        "stage": "Оклейка",
        "checklist": [
          "Плівку нанесено на зони",
          "Без бульбашок і задирів (фото ПІСЛЯ)"
        ]
      }
    ]
  }
};

// Старые константы оставлены для обратной совместимости (подряд/помощь и т.п.)
const CHAIN = ["Подготовка к полировке", "Полировка", "Повторная мойка", "Керамика"];
const FREE_STAGES = [];
const WASH_SERVICE = "Мойка (вся услуга)";
const TIME_OPTIONS = ["30 мин", "1 час", "2 часа", "4 часа", "1 день"];

// Коды услуг машины (колонка TYPE может содержать несколько через запятую).
// Возвращает массив валидных кодов в порядке протокола. Пусто — [].
function carServiceCodes(car) {
  const raw = String(car[A.TYPE - 1] || "").trim().toUpperCase();
  if (!raw) return [];
  return raw.split(",").map(function (c) { return c.trim(); })
            .filter(function (c) { return SERVICES[c]; });
}
// Первый код (для обратной совместимости / короткого показа). null если нет.
function carServiceCode(car) {
  const codes = carServiceCodes(car);
  return codes.length ? codes[0] : null;
}
// Определение услуги по коду.
function serviceDef(code) { return SERVICES[String(code).trim().toUpperCase()] || null; }
// Название одной услуги (UA основной, PL мелким).
function serviceLabelOne(code) {
  const s = serviceDef(code);
  if (!s) return String(code || "услуга");
  return s.name_ua + " (" + s.name_pl + ")";
}
// Общая подпись всех услуг машины.
function serviceLabel(codeOrCar) {
  // принимает либо один код-строку, либо массив кодов
  let codes;
  if (Array.isArray(codeOrCar)) codes = codeOrCar;
  else codes = String(codeOrCar || "").split(",").map(function (c) { return c.trim(); }).filter(Boolean);
  codes = codes.filter(function (c) { return SERVICES[c]; });
  if (!codes.length) return "услуга";
  return codes.map(serviceLabelOne).join(" + ");
}

// Уникальное имя этапа в цепочке машины: "КОД|Название этапа".
// Нужно чтобы одинаковые названия из разных услуг не путались.
function stageKey(code, stageName) { return code + "|" + stageName; }
function parseStageKey(key) {
  const i = String(key).indexOf("|");
  if (i === -1) return { code: "", stage: String(key) };
  return { code: key.slice(0, i), stage: key.slice(i + 1) };
}

// Полная цепочка этапов машины (все услуги подряд), массив уникальных ключей "КОД|Этап".
function carStageChain(car) {
  const chain = [];
  carServiceCodes(car).forEach(function (code) {
    const s = SERVICES[code];
    if (!s) return;
    s.stages.forEach(function (st) { chain.push(stageKey(code, st.stage)); });
  });
  return chain;
}
// Человекочитаемое имя этапа для показа (без кода услуги).
function stageDisplay(key) { return parseStageKey(key).stage; }
// Чеклист этапа по его ключу (знаем, какой услуге принадлежит).
function stageChecklistByKey(key) {
  const p = parseStageKey(key);
  const s = serviceDef(p.code);
  if (!s) return [];
  const found = s.stages.filter(function (st) { return st.stage === p.stage; })[0];
  return found ? found.checklist.slice() : [];
}
// Старые сигнатуры (используются в нескольких местах) — оставляем рабочими.
function serviceStageNames(code) {
  const s = serviceDef(code);
  if (!s) return [];
  return s.stages.map(function (st) { return st.stage; });
}
function stageChecklist(code, stageName) {
  const s = serviceDef(code);
  if (!s) return [];
  const found = s.stages.filter(function (st) { return st.stage === stageName; })[0];
  return found ? found.checklist.slice() : [];
}

// ALL_STAGES = все ключи "КОД|Этап" (для кодирования этапа в callback числом).
const ALL_STAGES = (function () {
  const set = [];
  Object.keys(SERVICES).forEach(function (code) {
    SERVICES[code].stages.forEach(function (st) {
      const key = code + "|" + st.stage;
      if (set.indexOf(key) === -1) set.push(key);
    });
  });
  // старые этапы (обратная совместимость с прежними логами)
  ["Подготовка к полировке", "Полировка", "Повторная мойка", "Керамика", "Салон", "Мойка (вся услуга)"]
    .forEach(function (st) { if (set.indexOf(st) === -1) set.push(st); });
  return set;
})();
function stageCode(name) { return ALL_STAGES.indexOf(name); }
function stageName(code) { return ALL_STAGES[Number(code)] || ""; }
function timeName(code) { return TIME_OPTIONS[Number(code)] || ""; }


// ═══════════════════ ТАБЛИЦА ═══════════════════
//
// ── ПЕР-АПДЕЙТНЫЙ КЭШ (главный ускоритель) ──────────────────────────────────
// Проблема оригинала: десятки функций (doneStages, hasPhoto, getRates, getStaff,
// autoRows, accruedFor...) на КАЖДЫЙ вызов дёргают db().getSheetByName().getRange().getValues().
// В хот-путях (showPayroll, finishStage, showMainMenu) один и тот же лист читается
// по 5-30 раз за одно нажатие кнопки. На GAS это скрывалось задержкой сети;
// на VPS с googleapis каждый такой ре-скан — лишний CPU/аллокации, отсюда «не летает».
//
// Решение: __cache__ живёт ровно один апдейт. resetCache() зовётся в начале
// onMessage/onCallback/тиков. Значения сбрасываются при любой записи в лист
// (setValue/appendRow эмулятора помечают лист dirty — но чтоб не зависеть от шима,
// мы точечно инвалидируем кэш в местах записи через bump(name)).
let __cache__ = Object.create(null);
function resetCache() { __cache__ = Object.create(null); }
function cacheGet(key, producer) {
  if (key in __cache__) return __cache__[key];
  const v = producer();
  __cache__[key] = v;
  return v;
}
// Инвалидация: зови после setCell/appendRow/setValue по конкретному листу.
function bump(name) {
  const pref = "sheet:" + name;
  for (const k in __cache__) if (k === pref || k.indexOf(pref + ":") === 0) delete __cache__[k];
}

// db() кэшируем — openById в шиме не бесплатен.
function db() {
  return cacheGet("__db__", function () { return SpreadsheetApp.openById(SHEET_ID); });
}
function sheet(name) { return db().getSheetByName(name); }

// Прочитать весь лист (со 2-й строки, ширина cols) ОДИН раз за апдейт.
// Возвращает массив строк (0-based значения). Все *Rows/get* используют это.
function sheetValues(name, cols) {
  return cacheGet("sheet:" + name + ":vals:" + cols, function () {
    const sh = sheet(name);
    if (!sh || sh.getLastRow() < 2) return [];
    return sh.getRange(2, 1, sh.getLastRow() - 1, cols).getValues();
  });
}

function cfg(key) {
  const map = cacheGet("__cfg__", function () {
    const sh = sheet("Настройки");
    const m = Object.create(null);
    if (sh && sh.getLastRow() >= 2) {
      const values = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
      for (const row of values) m[String(row[0])] = String(row[1]).trim();
    }
    return m;
  });
  return (key in map) ? map[key] : "";
}

// Токен Telegram дёргается на КАЖДЫЙ tg()-вызов — кэшируем на весь процесс.
let __tgToken__ = null;
function tgToken() {
  if (__tgToken__ == null) __tgToken__ = cfg("TELEGRAM_TOKEN");
  return __tgToken__;
}

// now() зовётся десятки раз за апдейт с одинаковым результатом (минутная точность) —
// но время может «перещёлкнуть» минуту в середине; поэтому НЕ кэшируем жёстко,
// только формат оставляем как есть (дёшево). Оставлено намеренно.
function now() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "dd.MM.yyyy HH:mm");
}


// ═══════════════════ TELEGRAM ═══════════════════
function tg(method, data) {
  const url = "https://api.telegram.org/bot" + tgToken() + "/" + method;
  const opts = {
    method: "post", contentType: "application/json",
    payload: JSON.stringify(data), muteHttpExceptions: true
  };
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = UrlFetchApp.fetch(url, opts);
      const json = JSON.parse(res.getContentText());
      if (!json.ok) {
        const desc = String(json.description || "");
        // Безобидный шум — не засоряем логи:
        //  • "message is not modified" — экран перерисован тем же текстом
        //  • "query is too old" — юзер нажал старую кнопку / ответ уже устарел
        const harmless = /message is not modified|query is too old|query ID is invalid/i.test(desc);
        if (!harmless) Logger.log("TG " + method + " not ok: " + res.getContentText());
        if (json.error_code === 429 && attempt < 3) { Utilities.sleep(1200); continue; }
      }
      return json;
    } catch (e) {
      lastErr = e;
      Logger.log("TG " + method + " fetch fail #" + attempt + ": " + e);
      if (attempt < 3) Utilities.sleep(800);
    }
  }
  Logger.log("TG " + method + " gave up: " + lastErr);
  return { ok: false, _neterror: true };
}

// ── ОПТИМИЗАЦИЯ: раньше каждый экран = deleteMessage + sendMessage (2 блокирующих
// curl-запроса). Теперь пытаемся отредактировать прошлое сообщение (1 запрос, без
// «мигания» чата). Fallback на delete+send только если edit не прошёл или прошлое
// сообщение было reply-клавиатурой (её editMessageText не берёт).
function send(chatId, text, keyboard) {
  const props = PropertiesService.getScriptProperties();
  const prev = props.getProperty("lastmsg_" + chatId);
  const prevKind = props.getProperty("lastmsgkind_" + chatId);

  if (prev && prevKind !== "reply") {
    const ep = { chat_id: chatId, message_id: Number(prev), text: text };
    ep.reply_markup = keyboard || { inline_keyboard: [] };
    const edited = tg("editMessageText", ep);
    if (edited && edited.ok) {
      props.setProperty("lastmsgkind_" + chatId, "inline");
      return edited;
    }
    // edit не удался (сообщение удалено/идентичный текст/было с медиа) → чистим и шлём заново
    if (!(edited && edited.description && /message is not modified/i.test(edited.description))) {
      tg("deleteMessage", { chat_id: chatId, message_id: prev });
    } else {
      return edited; // текст тот же — ничего слать не нужно
    }
  } else if (prev) {
    tg("deleteMessage", { chat_id: chatId, message_id: prev });
  }

  const p = { chat_id: chatId, text: text };
  if (keyboard) p.reply_markup = keyboard;
  const res = tg("sendMessage", p);
  if (res && res.ok && res.result && res.result.message_id) {
    props.setProperty("lastmsg_" + chatId, String(res.result.message_id));
    props.setProperty("lastmsgkind_" + chatId, "inline");
  }
  return res;
}

function sendMenu(chatId, text, keyboard) { return send(chatId, text, keyboard); }

function notify(chatId, text, keyboard) {
  const p = { chat_id: chatId, text: text };
  if (keyboard) p.reply_markup = keyboard;
  return tg("sendMessage", p);
}

function sendReplyKb(chatId, text, replyKeyboard) {
  const props = PropertiesService.getScriptProperties();
  const prev = props.getProperty("lastmsg_" + chatId);
  if (prev) tg("deleteMessage", { chat_id: chatId, message_id: prev });
  const res = tg("sendMessage", { chat_id: chatId, text: text, reply_markup: replyKeyboard });
  if (res && res.ok && res.result && res.result.message_id) {
    props.setProperty("lastmsg_" + chatId, String(res.result.message_id));
    props.setProperty("lastmsgkind_" + chatId, "reply"); // reply-kb нельзя редактировать текстом
  }
  return res;
}
function removeReplyKb(chatId, text) {
  const props = PropertiesService.getScriptProperties();
  const prev = props.getProperty("lastmsg_" + chatId);
  if (prev) tg("deleteMessage", { chat_id: chatId, message_id: prev });
  const res = tg("sendMessage", { chat_id: chatId, text: text, reply_markup: { remove_keyboard: true } });
  if (res && res.ok && res.result && res.result.message_id) {
    props.setProperty("lastmsg_" + chatId, String(res.result.message_id));
    props.setProperty("lastmsgkind_" + chatId, "inline");
  }
  return res;
}

function answer(qid, text) {
  tg("answerCallbackQuery", { callback_query_id: qid, text: text || "" });
}


// ═══════════════════ ПЕРСОНАЛ / ДОСТУП ═══════════════════
function getStaff() {
  return sheetValues("Персонал", 7);
}
function rowToUser(r, i) {
  return {
    row: i + 2,
    pin: String(r[0]).trim(),
    name: String(r[1]).trim(),
    telegram: String(r[2]).trim(),
    role: String(r[3]).trim(),
    canIssue: String(r[4]).toLowerCase().trim() === "да",
    active: String(r[5]).toLowerCase().trim() !== "нет",
    startSalary: Number(r[6]) || 0
  };
}
function startSalaryFor(workerName) {
  const d = getStaff();
  for (let i = 0; i < d.length; i++)
    if (String(d[i][1]).trim() === String(workerName).trim()) return Number(d[i][6]) || 0;
  return 0;
}
function getStaffByPin(pin) {
  const d = getStaff();
  for (let i = 0; i < d.length; i++)
    if (String(d[i][0]).trim() === String(pin).trim()) return rowToUser(d[i], i);
  return null;
}
function getStaffByTelegram(chatId) {
  const d = getStaff();
  for (let i = 0; i < d.length; i++)
    if (String(d[i][2]).trim() === String(chatId)) return rowToUser(d[i], i);
  return null;
}
function bindTelegram(pin, chatId) {
  const u = getStaffByPin(pin);
  if (!u) return null;
  sheet("Персонал").getRange(u.row, 3).setValue(String(chatId));
  bump("Персонал");
  SpreadsheetApp.flush();
  return getStaffByTelegram(chatId);
}
function adminChatId() {
  const d = getStaff();
  for (let i = 0; i < d.length; i++) {
    const u = rowToUser(d[i], i);
    if (u.role === "админ" && u.telegram && u.active) return u.telegram;
  }
  return "";
}
function notifyAdmin(text, keyboard) {
  const id = adminChatId();
  if (id) notify(id, text, keyboard);
}

function isAdmin(u)      { return u.role === "админ"; }
function isContractor(u) { return u.role === "подрядчик"; }
function isReception(u)  { return u.role === "приёмщик" || u.canIssue; }

// хелпер: пользователь по номеру строки листа Персонал
function getStaffByRow(row) {
  const d = getStaff();
  const idx = row - 2;
  if (idx < 0 || idx >= d.length) return null;
  return rowToUser(d[idx], idx);
}


// ═══════════════════ ГЕОЛОКАЦИЯ ═══════════════════
function distMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = function (d) { return d * Math.PI / 180; };
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)*Math.sin(dLat/2) +
            Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)*Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function checkGeo(lat, lon) {
  const sLat = Number(cfg("SERVICE_LAT")) || 50.09292833853505;
  const sLon = Number(cfg("SERVICE_LON")) || 19.96310018593254;
  const radius = Number(cfg("GEO_RADIUS_M")) || 300;
  if (!sLat || !sLon) return { ok: true, dist: 0, noConfig: true };
  const d = Math.round(distMeters(lat, lon, sLat, sLon));
  return { ok: d <= radius, dist: d, radius: radius };
}


// ═══════════════════ ЛИСТ "Авто" ═══════════════════
// Карта колонок листа "Авто" (1-based). Обращение: car[A.STATUS-1] (массив 0-based).
//  ID=ID заказа (KRK-XXXX) | PLATE=госномер | MODEL=марка | PHONE=тел клиента
//  PRICE=сумма заказа | TYPE=тип услуги | STATUS=в очереди/в работе/готова к выдаче/выдана
//  STAGE=текущий этап | WORKER=кто взял | START=время старта этапа | PLAN=план по времени
//  CONTRACT=подрядчик | FLAG=пометка парсера (⚠️ проверь..) | CREATED=создано
const A = { ID:1, PLATE:2, MODEL:3, PHONE:4, PRICE:5, TYPE:6, STATUS:7,
            STAGE:8, WORKER:9, START:10, PLAN:11, CONTRACT:12, FLAG:13, CREATED:14,
            PRICES:15 };

function autoRows() {
  return cacheGet("sheet:Авто:autoRows", function () {
    const sh = sheet("Авто");
    if (!sh || sh.getLastRow() < 2) return [];
    return sh.getRange(2, 1, sh.getLastRow() - 1, 14).getValues()
             .map(function (r, i) { r._row = i + 2; return r; });
  });
}
function findCar(id) {
  const rows = autoRows();
  for (const r of rows) if (String(r[A.ID-1]).trim() === String(id).trim()) return r;
  return null;
}
function setCell(row, col, val) {
  sheet("Авто").getRange(row, col).setValue(val);
  // Правим кэш точечно, без полного пере-чтения листа.
  const rows = __cache__["sheet:Авто:autoRows"];
  if (rows) { const idx = row - 2; if (rows[idx]) rows[idx][col - 1] = val; }
  delete __cache__["sheet:Авто:vals:14"];
}

function getBlacklistSheet() {
  let sh = db().getSheetByName("Удалённые");
  if (!sh) {
    sh = db().insertSheet("Удалённые");
    sh.getRange(1, 1, 1, 3).setValues([["ID заказа", "Когда", "Кто удалил"]]);
    sh.setFrozenRows(1);
  }
  return sh;
}
function isBlacklisted(carId) {
  getBlacklistSheet();
  const cid = String(carId).trim();
  const ids = sheetValues("Удалённые", 1);
  for (const r of ids) if (String(r[0]).trim() === cid) return true;
  return false;
}
function blacklistAdd(carId, who) { getBlacklistSheet().appendRow([carId, now(), who]); bump("Удалённые"); }


// ═══════════════════ ПАРСЕР PDF ═══════════════════
function parseProtocol(file) {
  let text = "", tmpId = null;
  try {
    const token = __DRIVE_TOKEN__();  // access token из drive-shim (Node-порт)
    const meta = { name: "tmp_" + file.getId(), mimeType: "application/vnd.google-apps.document" };
    const boundary = "xxKRAKENxx";
    const blob = file.getBlob();
    // Node: собираем multipart через Buffer (PDF → Google Doc с OCR pl)
    const __header = Buffer.from(
      "--" + boundary + "\r\n" +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      JSON.stringify(meta) + "\r\n" +
      "--" + boundary + "\r\n" +
      "Content-Type: application/pdf\r\n\r\n", "utf8");
    const __footer = Buffer.from("\r\n--" + boundary + "--\r\n", "utf8");
    const payload = Buffer.concat([__header, blob._buf, __footer]);

    // ВАЖНО: НЕ передаём ocrLanguage. Наши PDF генерируются через jsPDF и уже содержат
    // настоящий текстовый слой (проверено — коды услуг типа MYJ-MAX-SUV извлекаются 1-в-1).
    // Параметр ocrLanguage заставляет Drive растеризовать страницу и распознавать её через OCR
    // ВМЕСТО использования embedded-текста — а OCR как раз путает короткие технические коды
    // с дефисами (MYJ-MAX-SUV → мусор), хотя обычному тексту в протоколе ничего не грозит.
    // Поэтому сперва конвертируем БЕЗ OCR; на OCR переходим только если текстовый слой
    // почему-то пуст (напр. кто-то руками закинул скан вместо сгенерированного PDF).
    function convertPdfToText(useOcr) {
      const url = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true"
        + (useOcr ? "&ocrLanguage=pl" : "");
      const res = UrlFetchApp.fetch(url, {
        method: "post",
        contentType: "multipart/related; boundary=" + boundary,
        payload: payload,
        headers: { Authorization: "Bearer " + token },
        muteHttpExceptions: true });
      const json = JSON.parse(res.getContentText());
      if (!json.id) { Logger.log("PDF upload fail " + file.getName() + ": " + res.getContentText()); return null; }
      return json.id;
    }

    tmpId = convertPdfToText(false);
    if (tmpId) text = DocumentApp.openById(tmpId).getBody().getText();

    if (!text || !text.trim()) {
      // Текстового слоя не оказалось (реально скан) — только тогда пробуем OCR как fallback.
      if (tmpId) { try { DriveApp.getFileById(tmpId).setTrashed(true); } catch (e) { Logger.log("tmp cleanup: " + e); } }
      tmpId = convertPdfToText(true);
      if (tmpId) text = DocumentApp.openById(tmpId).getBody().getText();
      Logger.log("OCR-fallback[" + (file.getName ? file.getName() : "?") + "]: " + text.replace(/\n/g, " | ").slice(0, 1200));
    } else {
      Logger.log("TEXT[" + (file.getName ? file.getName() : "?") + "]: " + text.replace(/\n/g, " | ").slice(0, 1200));
    }
  } catch (err) {
    Logger.log("PDF read fail " + file.getName() + ": " + err);
    return null;
  } finally {
    if (tmpId) {
      try { DriveApp.getFileById(tmpId).setTrashed(true); } catch (e) { Logger.log("tmp cleanup: " + e); }
    }
  }

  const lines = text.split("\n").map(function (l) { return l.replace(/\s+/g, " ").trim(); })
                    .filter(function (l) { return l.length; });

  const idM = text.match(/KRK[-\s]?0*\d+/i);
  let orderId = "";
  if (idM) {
    const num = idM[0].match(/\d+/);
    orderId = "KRK-" + ("0000" + num[0]).slice(-4);
  }

  function lineIndexOf(label) {
    for (let i = 0; i < lines.length; i++)
      if (lines[i].toUpperCase().indexOf(label.toUpperCase()) !== -1) return i;
    return -1;
  }
  function valueUnder(label) {
    const i = lineIndexOf(label);
    return (i !== -1 && i + 1 < lines.length) ? lines[i + 1] : "";
  }
  function lineIndexOfAny(labels) {
    for (let i = 0; i < lines.length; i++)
      for (let k = 0; k < labels.length; k++)
        if (lines[i].toUpperCase().indexOf(labels[k].toUpperCase()) !== -1) return i;
    return -1;
  }
  function valueUnderAny(labels) {
    const i = lineIndexOfAny(labels);
    return (i !== -1 && i + 1 < lines.length) ? lines[i + 1] : "";
  }

  const L_NAME  = ["IMIĘ I NAZWISKO", "ІМ'Я ТА ПРІЗВИЩЕ", "ІМ'Я", "IMIE I NAZWISKO"];
  const L_MODEL = ["MARKA I MODEL", "МАРКА ТА МОДЕЛЬ", "МАРКА"];
  const L_PHONE = ["TELEFON", "ТЕЛЕФОН"];
  const L_PLATE = ["NR REJESTRACYJNY", "ДЕРЖ. НОМЕР", "ДЕРЖ НОМЕР", "ДЕРЖАВНИЙ НОМЕР", "НОМЕР"];
  const L_TOTAL = ["RAZEM", "РАЗОМ"];

  let name = "", model = "";
  {
    const i = lineIndexOfAny(L_NAME);
    if (i !== -1 && i + 1 < lines.length) {
      const valLine = lines[i + 1];
      const hasModelLabelInline = /MARKA|МАРКА/i.test(lines[i]);
      if (hasModelLabelInline) {
        const parts = valLine.split(" ").filter(Boolean);
        name = parts[0] || "";
        model = parts.slice(1).join(" ") || "";
      } else {
        name = valLine;
        model = valueUnderAny(L_MODEL);
      }
    }
  }
  if (!model) model = valueUnderAny(L_MODEL);

  let phone = "", plate = "";
  {
    const i = lineIndexOfAny(L_PLATE);
    if (i !== -1 && i + 1 < lines.length) {
      const tok = lines[i + 1].split(" ").filter(Boolean);
      if (tok.length >= 2) {
        const phoneTok = tok.find(function (t) { return /^\+?\d{6,}$/.test(t); });
        phone = phoneTok || "";
        plate = tok.filter(function (t) { return t !== phoneTok; }).join("") || tok[tok.length - 1];
      } else if (tok.length === 1) {
        plate = tok[0];
      }
    }
  }
  if (!phone || !/\d{6,}/.test(phone)) {
    const pm = valueUnderAny(L_PHONE).match(/\+?\d{6,}/);
    if (pm) phone = pm[0];
  }
  if (!plate || plate === "—") {
    const m2 = text.match(/KRK[-\s]?\d+\s*[·•∙]\s*([A-Za-zА-Яа-яІіЇїЄє0-9]+)/);
    if (m2 && m2[1] !== "—") plate = m2[1];
  }

  let total = "";
  const sumM = text.match(/(?:RAZEM|РАЗОМ):?\s*([\d\s.,]+)/i);
  if (sumM) total = sumM[1].replace(/[^\d]/g, "").trim();

  // ── Код услуги из протокола (колонка «Kod» и/или QR-строка «SRV:CODE,CODE»).
  // Берём коды, которые есть в справочнике SERVICES. Основной = первый найденный.
  const foundCodes = [];
  {
    const up = text.toUpperCase();
    // 1) QR-строка SRV:CODE,CODE — самый надёжный источник, если OCR его поймал.
    const srvM = up.match(/SRV:\s*([A-Z0-9,\-\s]+)/);
    if (srvM) {
      srvM[1].split(",").forEach(function (c) {
        const cc = c.trim();
        if (SERVICES[cc] && foundCodes.indexOf(cc) === -1) foundCodes.push(cc);
      });
    }
    // 2) Колонка «Kod». OCR часто искажает мелкий серый текст:
    //    дефис→пробел/точка, O↔0, I↔1, поэтому ищем каждый код по «размытому» шаблону.
    //    Нормализуем и текст, и код: убираем всё кроме букв/цифр, 0→O, 1→I.
    function fuzzy(s) {
      return String(s).toUpperCase()
        .replace(/0/g, "O").replace(/1/g, "I")
        .replace(/[^A-Z0-9]/g, "");
    }
    const upFuzzy = fuzzy(up);
    const positions = [];
    Object.keys(SERVICES).forEach(function (cc) {
      // точное совпадение — приоритетно (точная позиция в тексте)
      let pos = up.indexOf(cc);
      if (pos === -1) {
        // размытое совпадение
        const idx = upFuzzy.indexOf(fuzzy(cc));
        if (idx !== -1) pos = idx;
      }
      if (pos !== -1) positions.push({ code: cc, pos: pos });
    });
    positions.sort(function (a, b) { return a.pos - b.pos; });
    positions.forEach(function (p) {
      if (foundCodes.indexOf(p.code) === -1) foundCodes.push(p.code);
    });
  }
  const serviceCode = foundCodes.join(",");

  // ── Цена КАЖDОЙ услуги отдельно (для раздельного процента работникам).
  // В строке протокола после кода идёт название и цена: "OKL-TINT ... 500 zł".
  // Ищем в тексте первое число zł после каждого кода. Результат: "CODE:price,CODE:price".
  const codePrices = {};
  {
    const upText = text.toUpperCase();
    foundCodes.forEach(function (code) {
      let pos = upText.indexOf(code);
      if (pos === -1) return;
      // берём кусок текста от кода до +120 символов, ищем первое число перед zł/зл
      const chunk = text.slice(pos, pos + 120);
      const pm = chunk.match(/(\d[\d\s.,]*)\s*(?:ZŁ|ZL|ЗЛ|PLN)/i);
      if (pm) {
        const val = pm[1].replace(/[^\d]/g, "");
        if (val) codePrices[code] = Number(val);
      }
    });
  }
  const pricesStr = foundCodes.map(function (c) {
    return c + ":" + (codePrices[c] || 0);
  }).join(",");

  const missing = [];
  if (!plate || plate === "—") missing.push("госномер");
  if (!phone || phone === "—") missing.push("телефон");
  if (!total) missing.push("сумма");
  if (!serviceCode) missing.push("услуга");

  return {
    orderId: orderId,
    plate: (plate && plate !== "—") ? plate : "",
    model: model,
    phone: (phone && phone !== "—") ? phone : "",
    total: total,
    serviceCode: serviceCode,
    allCodes: foundCodes,
    prices: pricesStr,
    flag: missing.length ? "⚠️ проверь: " + missing.join(", ") : ""
  };
}

// ── Кэш разобранных PDF: fileId -> orderId (ускоритель)
function getParsedCache() {
  const raw = PropertiesService.getScriptProperties().getProperty("parsed_files") || "{}";
  try { return JSON.parse(raw); } catch (e) { return {}; }
}
function saveParsedCache(obj) {
  const keys = Object.keys(obj);
  if (keys.length > 500) {
    const trimmed = {};
    keys.slice(keys.length - 400).forEach(function (k) { trimmed[k] = obj[k]; });
    obj = trimmed;
  }
  PropertiesService.getScriptProperties().setProperty("parsed_files", JSON.stringify(obj));
}

// Новый syncQueue: кэш + отсев по имени файла + парсинг только новых
function syncQueue() {
  const folderId = cfg("DRIVE_FOLDER_ID");
  if (!folderId) return "❌ Не задан DRIVE_FOLDER_ID в Настройках.";
  let folder;
  try { folder = DriveApp.getFolderById(folderId); }
  catch (e) { return "❌ Не нашёл папку. Проверь DRIVE_FOLDER_ID."; }

  const sh = sheet("Авто");
  const existing = {};
  if (sh.getLastRow() > 1)
    sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues()
      .forEach(function (r) { existing[String(r[0]).trim()] = true; });

  const seen = getParsedCache();
  const files = folder.getFilesByType("application/pdf");
  let added = 0; const skipped = []; const dupes = []; const removed = []; let cacheChanged = false;

  while (files.hasNext()) {
    const file = files.next();
    const fileId = file.getId();
    if (seen[fileId]) continue;

    const nameM = file.getName().match(/KRK[-\s]?0*(\d+)/i);
    if (nameM) {
      const oid = "KRK-" + ("0000" + nameM[1]).slice(-4);
      if (existing[oid]) { dupes.push(file.getName() + " (" + oid + ")"); seen[fileId] = oid; cacheChanged = true; continue; }
      if (isBlacklisted(oid)) { removed.push(file.getName() + " (" + oid + ")"); seen[fileId] = oid; cacheChanged = true; continue; }
    }

    const d = parseProtocol(file);
    if (!d || !d.orderId) {
      skipped.push(file.getName());
      seen[fileId] = "__skip__"; cacheChanged = true;
      continue;
    }
    seen[fileId] = d.orderId; cacheChanged = true;
    if (existing[d.orderId]) { dupes.push(file.getName() + " (" + d.orderId + ")"); continue; }
    if (isBlacklisted(d.orderId)) { removed.push(file.getName() + " (" + d.orderId + ")"); continue; }

    sh.appendRow([d.orderId, d.plate, d.model, d.phone, d.total,
      d.serviceCode || "", "в очереди", "", "", "", "", "", d.flag, now(), d.prices || ""]);
    existing[d.orderId] = true; added++;
  }

  if (cacheChanged) saveParsedCache(seen);
  let rep = "✅ Обновлено. Новых машин: " + added + ".";
  if (dupes.length)   rep += "\n🔁 Уже были в списке: " + dupes.join(", ");
  if (removed.length) rep += "\n🗑 Ранее удалялись вручную: " + removed.join(", ");
  if (skipped.length) rep += "\n⚠️ Не распознаны: " + skipped.join(", ");
  return rep;
}


// ═══════════════════ ЭТАПЫ ═══════════════════
function doneStages(carId) {
  const cid = String(carId).trim();
  const rows = sheetValues("Логи", 11);
  const done = [];
  for (let i = 0; i < rows.length; i++)
    if (String(rows[i][1]).trim() === cid) done.push(String(rows[i][4]).trim());
  return done;
}
// Есть ли фото данной фазы ("до"/"после") по машине (в листе "Фото")
function hasPhoto(carId, phase) {
  const cid = String(carId).trim(), ph = String(phase).trim();
  const rows = sheetValues("Фото", 6);
  for (let i = 0; i < rows.length; i++)
    if (String(rows[i][1]).trim() === cid && String(rows[i][2]).trim() === ph) return true;
  return false;
}
function availableStages(car) {
  // Цепочка всех услуг машины (ключи "КОД|Этап"). Возвращаем первый несделанный.
  const chain = carStageChain(car);
  const done = doneStages(car[A.ID-1]);
  if (!chain.length) {
    // Услуга не распознана — старое запасное поведение.
    const out = [];
    let nextChain = null;
    for (const st of CHAIN) if (done.indexOf(st) === -1) { nextChain = st; break; }
    if (nextChain) out.push(nextChain);
    if (done.length === 0) out.push(WASH_SERVICE);
    return out;
  }
  // Показываем первый несделанный этап КАЖДОЙ услуги — работник сам выбирает,
  // какую услугу делать. Внутри услуги порядок этапов сохраняется.
  const out = [];
  const codes = carServiceCodes(car);
  codes.forEach(function (code) {
    const stages = SERVICES[code].stages.map(function (st) { return code + "|" + st.stage; });
    for (const key of stages) {
      if (done.indexOf(key) === -1) { out.push(key); break; }
    }
  });
  return out;
}
// Все ли этапы всех услуг машины пройдены (с учётом только что закрытого)?
function serviceAllDone(carId, justFinishedStage) {
  const car = findCar(carId);
  if (!car) return false;
  const chain = carStageChain(car);
  const done = doneStages(carId);
  if (!chain.length) {
    return CHAIN.every(function (st) { return st === justFinishedStage || done.indexOf(st) !== -1; });
  }
  return chain.every(function (key) { return key === justFinishedStage || done.indexOf(key) !== -1; });
}
function stagesOverview(carId) {
  const car = findCar(carId);
  const chain = car ? carStageChain(car) : [];
  const done = doneStages(carId);
  const all = chain.length ? chain : CHAIN;
  const doneList = [], leftList = [];
  all.forEach(function (key) {
    const label = chain.length ? stageDisplay(key) : key;
    if (done.indexOf(key) !== -1) doneList.push(label); else leftList.push(label);
  });
  let txt = "";
  if (chain.length) txt += "🧰 Услуга: " + serviceLabel(carServiceCodes(car)) + "\n";
  if (doneList.length) txt += "✅ Сделано: " + doneList.join(" → ") + "\n";
  if (leftList.length) {
    txt += "⏳ Осталось: " + leftList.join(" → ");
  } else if (all.length) {
    txt += "🏁 Все этапы закрыты — на выдачу.";
  } else {
    txt += "⏳ Услуга не распознана — уточни у приёмщика.";
  }
  return txt;
}


// ═══════════════════ СТАВКИ / РАСЧЁТ ЗП ═══════════════════
function getRates() {
  return cacheGet("__rates__", function () {
    const rows = sheetValues("Ставки", 5);
    return rows
      .filter(function (r) { return r[2]; })
      .map(function (r) { return { prio: r[0], name: String(r[1]).trim(),
        stage: String(r[2]).trim(), type: String(r[3]).trim(), value: Number(r[4]) }; })
      .sort(function (a, b) { return a.prio - b.prio; });
  });
}
function fixedPaidSoFar(carId) {
  const cid = String(carId).trim();
  const rows = sheetValues("Логи", 11);
  const rates = getRates();
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[1]).trim() !== cid) continue;
    const stage = String(r[4]).trim(), worker = String(r[3]).trim();
    const rule = rates.find(function (rt) {
      return rt.stage === stage && rt.type === "фикс" && (rt.name === "*" || rt.name === worker);
    });
    if (rule) sum += Number(r[9]) || 0;
  }
  return sum;
}
// Цена конкретной услуги (по коду) для машины. Из колонки PRICES "CODE:price,...".
// Если не нашли — откат на общую цену машины.
function servicePriceForCode(car, code) {
  const raw = String(car[A.PRICES-1] || "").trim();
  if (raw && code) {
    const parts = raw.split(",");
    for (let i = 0; i < parts.length; i++) {
      const kv = parts[i].split(":");
      if (kv[0] && kv[0].trim().toUpperCase() === String(code).trim().toUpperCase()) {
        const v = Number(kv[1]);
        if (isFinite(v) && v > 0) return v;
      }
    }
  }
  return Number(car[A.PRICE-1]) || 0;
}
// Последний ли это этап своей услуги (с учётом того, что он сейчас закрывается)?
// Значит все остальные этапы ЭТОЙ услуги уже сделаны.
function serviceLastStageDone(car, stageKeyNow) {
  const p = (typeof parseStageKey === "function") ? parseStageKey(stageKeyNow) : { code: "", stage: stageKeyNow };
  if (!p.code || !SERVICES[p.code]) return true; // нет услуги — старое поведение (платим за этап)
  const done = doneStages(car[A.ID-1]);
  const stagesOfService = SERVICES[p.code].stages.map(function (st) { return p.code + "|" + st.stage; });
  return stagesOfService.every(function (key) {
    return key === stageKeyNow || done.indexOf(key) !== -1;
  });
}
function calcPay(workerName, stage, car) {
  const carId = car[A.ID-1];
  const rates = getRates();
  // stage — ключ "КОД|Этап". Берём цену именно этой услуги, а не всей машины.
  const p = (typeof parseStageKey === "function") ? parseStageKey(stage) : { code: "", stage: stage };
  const stageName = p.stage || stage;
  const price = p.code ? servicePriceForCode(car, p.code) : (Number(car[A.PRICE-1]) || 0);

  // Ставку ищем по КОДУ услуги (удобно: одна строка в таблице = одна услуга).
  // В листе "Ставки" колонка "этап" может содержать код (OKL-TINT) ИЛИ имя этапа.
  let rule = null;
  if (p.code) {
    rule = rates.find(function (r) { return r.stage === p.code && r.name === workerName; });
    if (!rule) rule = rates.find(function (r) { return r.stage === p.code && r.name === "*"; });
  }
  // запасной поиск по имени этапа (старый способ)
  if (!rule) rule = rates.find(function (r) { return r.stage === stageName && r.name === workerName; });
  if (!rule) rule = rates.find(function (r) { return r.stage === stageName && r.name === "*"; });
  // общий wildcard: этап "*" — покрывает любую услугу без своей ставки
  if (!rule) rule = rates.find(function (r) { return r.stage === "*" && r.name === workerName; });
  if (!rule) rule = rates.find(function (r) { return r.stage === "*" && r.name === "*"; });
  if (!rule) return 50;
  if (rule.type === "фикс") return rule.value;
  if (rule.type === "процент") {
    return Math.max(0, Math.round(price * rule.value / 100 * 100) / 100);
  }
  return 50;
}
// Сколько фикс-оплат уже начислено по конкретной услуге (коду) машины.
function fixedPaidForCode(carId, code) {
  const cid = String(carId).trim();
  const rows = sheetValues("Логи", 11);
  const rates = getRates();
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[1]).trim() !== cid) continue;
    const key = String(r[4]).trim();
    const kp = (typeof parseStageKey === "function") ? parseStageKey(key) : { code: "", stage: key };
    if (code && kp.code && kp.code.toUpperCase() !== String(code).toUpperCase()) continue;
    const worker = String(r[3]).trim();
    const rule = rates.find(function (rt) {
      return rt.stage === kp.stage && rt.type === "фикс" && (rt.name === "*" || rt.name === worker);
    });
    if (rule) sum += Number(r[9]) || 0;
  }
  return sum;
}

// ── ЛИЧНЫЙ РЕКОРД по этапу: минимальный факт-минут этого мастера на этом этапе.
// Данные берём из Логов (колонки: мастер=idx3, этап=idx4, минут=idx8). Новых полей нет.
function personalBestMin(workerName, stage) {
  const wn = String(workerName).trim(), st = String(stage).trim();
  const rows = sheetValues("Логи", 11);
  let best = null;
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][3]).trim() !== wn || String(rows[i][4]).trim() !== st) continue;
    const m = Number(rows[i][8]);
    if (!isFinite(m) || m <= 0) continue;
    if (best === null || m < best) best = m;
  }
  return best; // null если ещё не делал
}
// Живая оценка суммы за текущий этап (без записи в Логи — только показать).
function estimateStagePay(workerName, stage, car) {
  try { return calcPay(workerName, stage, car); } catch (e) { return null; }
}
function parseDt(str) {
  const p = String(str).trim().match(/(\d{2})\.(\d{2})\.(\d{4})[ T](\d{2}):(\d{2})/);
  if (!p) return null;
  return new Date(Number(p[3]), Number(p[2]) - 1, Number(p[1]), Number(p[4]), Number(p[5]));
}
function payPeriod(ref) {
  const d = ref || new Date();
  let sm = d.getMonth(), sy = d.getFullYear();
  if (d.getDate() < 10) { sm -= 1; if (sm < 0) { sm = 11; sy -= 1; } }
  return { from: new Date(sy, sm, 10, 0, 0, 0), to: new Date(sy, sm + 1, 10, 0, 0, 0) };
}
function periodLabel(period) {
  const f = Utilities.formatDate(period.from, Session.getScriptTimeZone(), "dd.MM");
  const t = Utilities.formatDate(new Date(period.to.getTime() - 86400000),
            Session.getScriptTimeZone(), "dd.MM.yyyy");
  return f + "–" + t;
}
function minutesBetween(fromStr, toStr) {
  const a = parseDt(fromStr), b = parseDt(toStr);
  if (!a || !b) return "";
  return Math.round((b - a) / 60000);
}
function fmtDur(mins) {
  const m = Number(mins) || 0;
  return Math.floor(m / 60) + "ч " + (m % 60) + "м";
}


// ═══════════════════ ВЫПЛАТЫ ═══════════════════
function getPayoutsSheet() {
  let sh = db().getSheetByName("Выплаты");
  if (!sh) {
    sh = db().insertSheet("Выплаты");
    sh.getRange(1, 1, 1, 4).setValues([["Когда", "Мастер", "Сумма", "Кто выдал"]]);
    sh.setFrozenRows(1);
  }
  return sh;
}
function payoutAdd(workerName, amount, who) { getPayoutsSheet().appendRow([now(), workerName, amount, who]); bump("Выплаты"); }

function accruedFor(workerName, period) {
  const wn = String(workerName).trim();
  const rows = sheetValues("Логи", 11);
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[3]).trim() !== wn) continue;
    const dt = parseDt(r[0]);
    if (dt && dt >= period.from && dt < period.to) sum += Number(r[9]) || 0;
  }
  const cur = payPeriod();
  if (period.from.getTime() === cur.from.getTime()) sum += startSalaryFor(workerName);
  return Math.round(sum * 100) / 100;
}
function paidOutFor(workerName, period) {
  getPayoutsSheet(); // гарантирует существование листа
  const wn = String(workerName).trim();
  const rows = sheetValues("Выплаты", 4);
  let sum = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[1]).trim() !== wn) continue;
    const dt = parseDt(r[0]);
    if (dt && dt >= period.from && dt < period.to) sum += Number(r[2]) || 0;
  }
  return Math.round(sum * 100) / 100;
}
function salaryBreakdown(workerName, period) {
  const wn = String(workerName).trim();
  const rows = sheetValues("Логи", 11);
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[3]).trim() !== wn) continue;
    const dt = parseDt(r[0]);
    if (dt && dt >= period.from && dt < period.to)
      out.push({ when: String(r[0]), plate: String(r[2]), stage: String(r[4]), pay: Number(r[9]) || 0 });
  }
  return out;
}


// ═══════════════════ СМЕНЫ (лист "Смены") ═══════════════════
function getShiftSheet() {
  let sh = db().getSheetByName("Смены");
  if (!sh) {
    sh = db().insertSheet("Смены");
    sh.getRange(1, 1, 1, 6).setValues([["Дата/время", "Мастер", "Событие", "Гео", "Минут", "Коммент"]]);
    sh.setFrozenRows(1);
  }
  return sh;
}
function shiftRows() {
  getShiftSheet();
  return sheetValues("Смены", 6);
}
function shiftLog(workerName, event, geo, minutes) {
  getShiftSheet().appendRow([now(), workerName, event, geo || "", minutes || "", ""]);
  bump("Смены");
}
function lastShiftEvent(workerName) {
  const wn = String(workerName).trim();
  const rows = shiftRows();
  for (let i = rows.length - 1; i >= 0; i--)
    if (String(rows[i][1]).trim() === wn)
      return { when: String(rows[i][0]), event: String(rows[i][2]).trim() };
  return null;
}
function findShiftStart(workerName) {
  const wn = String(workerName).trim();
  const rows = shiftRows();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][1]).trim() !== wn) continue;
    const ev = String(rows[i][2]).trim();
    if (ev === "пришёл") return String(rows[i][0]);
    if (ev === "ушёл") return null;
  }
  return null;
}
function isOnShift(workerName) {
  const last = lastShiftEvent(workerName);
  if (!last) return false;
  return last.event === "пришёл" || last.event === "возврат";
}

const SHIFT_START_H = 9, SHIFT_START_M = 0;
const LATE_GRACE_MIN = 10;
const SHIFT_END_H = 19, SHIFT_END_M = 0;

function lateMinutes() {
  const d = new Date();
  const startToday = new Date(d.getFullYear(), d.getMonth(), d.getDate(), SHIFT_START_H, SHIFT_START_M + LATE_GRACE_MIN, 0);
  if (d <= startToday) return 0;
  return Math.round((d - new Date(d.getFullYear(), d.getMonth(), d.getDate(), SHIFT_START_H, SHIFT_START_M, 0)) / 60000);
}
function earlyLeaveMinutes() {
  const d = new Date();
  const endToday = new Date(d.getFullYear(), d.getMonth(), d.getDate(), SHIFT_END_H, SHIFT_END_M, 0);
  if (d >= endToday) return 0;
  return Math.round((endToday - d) / 60000);
}
function appendShiftComment(workerName, comment) {
  const sh = getShiftSheet();
  const wn = String(workerName).trim();
  const rows = shiftRows();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][1]).trim() === wn) {
      const old = String(rows[i][5] || "").trim();
      sh.getRange(i + 2, 6).setValue(old ? old + " | " + comment : comment);
      bump("Смены");
      return;
    }
  }
}


// ═══════════════════ КАССЫ ═══════════════════
function getCashSheet() {
  let sh = db().getSheetByName("КассаНал");
  if (!sh) { sh = db().insertSheet("КассаНал");
    sh.getRange(1,1,1,6).setValues([["Дата/время","Тип","Сумма","Кто","Машина","Комментарий"]]);
    sh.setFrozenRows(1); }
  return sh;
}
function getCardSheet() {
  let sh = db().getSheetByName("Безнал");
  if (!sh) { sh = db().insertSheet("Безнал");
    sh.getRange(1,1,1,5).setValues([["Дата/время","Сумма","Кто","Машина","Комментарий"]]);
    sh.setFrozenRows(1); }
  return sh;
}
function getCompanySheet() {
  let sh = db().getSheetByName("Фирма");
  if (!sh) { sh = db().insertSheet("Фирма");
    sh.getRange(1,1,1,6).setValues([["Дата/время","Тип","Сумма","Источник","Кто","Комментарий"]]);
    sh.setFrozenRows(1); }
  return sh;
}
function cashAdd(type, amount, who, car, note) { getCashSheet().appendRow([now(), type, amount, who, car||"", note||""]); bump("КассаНал"); }
function cardAdd(amount, who, car, note) { getCardSheet().appendRow([now(), amount, who, car||"", note||""]); bump("Безнал"); }
function companyAdd(type, amount, source, who, note) { getCompanySheet().appendRow([now(), type, amount, source, who, note||""]); bump("Фирма"); }

// Баланс кассы = стартовый нал (КАССА_СТАРТ) + приходы − инкассации
function cashBalance() {
  getCashSheet();
  let bal = Number(cfg("КАССА_СТАРТ")) || 0;
  sheetValues("КассаНал", 3).forEach(function (r) {
    const t = String(r[1]).trim(), v = Number(r[2]) || 0;
    if (t === "приход") bal += v; else if (t === "инкассация") bal -= v;
  });
  return Math.round(bal*100)/100;
}
// Баланс фирмы = стартовый (ФИРМА_СТАРТ) + приходы − расходы
function companyBalance() {
  getCompanySheet();
  let bal = Number(cfg("ФИРМА_СТАРТ")) || 0;
  sheetValues("Фирма", 3).forEach(function (r) {
    const t = String(r[1]).trim(), v = Number(r[2]) || 0;
    if (t === "приход") bal += v; else if (t === "расход") bal -= v;
  });
  return Math.round(bal*100)/100;
}
function cardTotal(period) {
  getCardSheet();
  let sum = 0;
  sheetValues("Безнал", 2).forEach(function (r) {
    const dt = parseDt(r[0]);
    if (period && (!dt || dt < period.from || dt >= period.to)) return;
    sum += Number(r[1]) || 0;
  });
  return Math.round(sum*100)/100;
}
function cashInTotal(period) {
  getCashSheet();
  let sum = 0;
  sheetValues("КассаНал", 3).forEach(function (r) {
    if (String(r[1]).trim() !== "приход") return;
    const dt = parseDt(r[0]);
    if (!dt || dt < period.from || dt >= period.to) return;
    sum += Number(r[2]) || 0;
  });
  return Math.round(sum*100)/100;
}
function companySumByType(type, period) {
  getCompanySheet();
  let sum = 0;
  sheetValues("Фирма", 3).forEach(function (r) {
    if (String(r[1]).trim() !== type) return;
    const dt = parseDt(r[0]);
    if (!dt || dt < period.from || dt >= period.to) return;
    sum += Number(r[2]) || 0;
  });
  return Math.round(sum*100)/100;
}


// ═══════════════════ ДОСТУП ПОДРЯДЧИКА ═══════════════════
function getGrantSheet() {
  let sh = db().getSheetByName("Доступы");
  if (!sh) { sh = db().insertSheet("Доступы");
    sh.getRange(1,1,1,5).setValues([["Машина","Подрядчик","Ставка","Статус","Когда"]]);
    sh.setFrozenRows(1); }
  return sh;
}
function grantRows() { getGrantSheet(); return sheetValues("Доступы", 5); }
function grantOpen(carId, contractorName, rate) {
  getGrantSheet().appendRow([carId, contractorName, rate, "открыт", now()]);
  bump("Доступы");
}
function grantFor(carId, contractorName) {
  const cid = String(carId).trim(), cn = String(contractorName).trim();
  const rows = grantRows();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][0]).trim() === cid &&
        String(rows[i][1]).trim() === cn &&
        String(rows[i][3]).trim() === "открыт")
      return { rate: Number(rows[i][2]) || 0, row: i + 2 };
  }
  return null;
}
function openGrantsFor(contractorName) {
  const cn = String(contractorName).trim();
  const out = [];
  grantRows().forEach(function (r, i) {
    if (String(r[1]).trim() === cn && String(r[3]).trim() === "открыт")
      out.push({ carId: String(r[0]).trim(), rate: Number(r[2]) || 0, row: i + 2 });
  });
  return out;
}
function grantClose(row) { getGrantSheet().getRange(row, 4).setValue("закрыт"); bump("Доступы"); }
function openGrantByCar(carId) {
  const cid = String(carId).trim();
  const rows = grantRows();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][0]).trim() === cid && String(rows[i][3]).trim() === "открыт")
      return { carId: String(rows[i][0]).trim(), contractor: String(rows[i][1]).trim(),
               rate: Number(rows[i][2]) || 0, row: i + 2 };
  }
  return null;
}
function payContractorOnIssue(carId) {
  const g = openGrantByCar(carId);
  if (!g) return;
  const cid = String(carId).trim();
  // Защита от двойного начисления: если по машине уже есть строка оплаты подряда — выходим.
  const lrows = sheetValues("Логи", 11);
  for (const r of lrows) {
    if (String(r[1]).trim() === cid && String(r[4]).trim() === "Подряд (машина)") {
      grantClose(g.row); // грант закрываем, но деньги повторно НЕ пишем
      return;
    }
  }
  const car = findCar(carId);
  const plate = car ? (car[A.PLATE-1] || "") : "";
  sheet("Логи").appendRow([now(), carId, plate, g.contractor, "Подряд (машина)", "", "", now(), "", g.rate, "ставка за машину, начислено при выдаче"]);
  bump("Логи");
  grantClose(g.row);
  const c = findStaffByName(g.contractor);
  if (c && c.telegram) notify(c.telegram, "💰 Машина " + (car ? (car[A.MODEL-1] || carId) : carId) +
    " выдана клиенту.\nТебе начислено " + g.rate + " zł за эту машину.");
  notifyAdmin("🔧 Подрядчику " + g.contractor + " начислено " + g.rate + " zł (машина " + carId + " выдана).");
}


// ═══════════════════ КЛИЕНТЫ ПРИЁМЩИКА ═══════════════════
function getClientSheet() {
  let sh = db().getSheetByName("КлиентыСани");
  if (!sh) { sh = db().insertSheet("КлиентыСани");
    sh.getRange(1,1,1,4).setValues([["Дата/время","Приёмщик","Событие","Минут"]]);
    sh.setFrozenRows(1); }
  return sh;
}
function clientLog(name, event, minutes) { getClientSheet().appendRow([now(), name, event, minutes||""]); bump("КлиентыСани"); }
function receptionBusySince(name) {
  getClientSheet();
  const nm = String(name).trim();
  const rows = sheetValues("КлиентыСани", 4);
  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][1]).trim() !== nm) continue;
    if (String(rows[i][2]).trim() === "принял") return String(rows[i][0]);
    if (String(rows[i][2]).trim() === "освободился") return null;
  }
  return null;
}
function findStaffByName(name) {
  const d = getStaff();
  for (let i = 0; i < d.length; i++) { const u = rowToUser(d[i], i); if (u.name === String(name).trim()) return u; }
  return null;
}


// ═══════════════════ ГЛАВНОЕ МЕНЮ ═══════════════════
function showMainMenu(chatId, user) {
  const menu = [];

  if (isContractor(user)) {
    const grants = openGrantsFor(user.name);
    grants.forEach(function (g) {
      const car = findCar(g.carId);
      const label = car ? (car[A.MODEL-1] || g.carId) + " — " + (car[A.PLATE-1] || "") : g.carId;
      menu.push([{ text: "🚗 " + label + " (" + g.rate + " zł)", callback_data: "g_take:" + g.carId }]);
    });
    menu.push([{ text: "🔧 Запросить машину", callback_data: "req_car" }]);
    menu.push([{ text: "💰 Моя зарплата", callback_data: "mysalary" }]);
    const hdr = grants.length
      ? "🐙 KRAKEN — " + user.name + " (подрядчик)\n🚗 У тебя " + grants.length + " открытых машин. Деньги — после выдачи клиенту."
      : "🐙 KRAKEN — " + user.name + " (подрядчик)";
    sendMenu(chatId, hdr, { inline_keyboard: menu });
    return;
  }

  if (isAdmin(user)) {
    menu.push([{ text: "🚗 Машины в очереди", callback_data: "queue" }]);
    menu.push([{ text: "🔄 Обновить список машин", callback_data: "refresh" }]);
    menu.push([{ text: "📋 Машины в работе", callback_data: "my" }]);
    menu.push([{ text: "📦 Готовы к выдаче", callback_data: "ready" }]);
    menu.push([{ text: "💵 Касса (нал)", callback_data: "cash" }]);
    menu.push([{ text: "💳 Принять картой", callback_data: "card_add" }]);
    menu.push([{ text: "🧾 Зарплаты (все)", callback_data: "payroll" }]);
    menu.push([{ text: "🏦 Счёт фирмы", callback_data: "company" }]);
    menu.push([{ text: "📊 Сводка за период", callback_data: "summary" }]);
    menu.push([{ text: "👥 Часы по сменам", callback_data: "sum_hours" }]);
    menu.push([{ text: "📅 Статистика за день", callback_data: "daystats:0" }]);
    menu.push([{ text: "👷 Персонал / доступ", callback_data: "staff" }]);
    menu.push([{ text: "⚙️ Админ-панель", callback_data: "admin" }]);
    sendMenu(chatId, "🐙 KRAKEN — руководитель " + user.name, { inline_keyboard: menu });
    return;
  }

  const onShift = isOnShift(user.name);
  const lastEv = lastShiftEvent(user.name);
  const onBreak = lastEv && lastEv.event === "перерыв";

  let hdr = "🐙 KRAKEN — " + user.name;
  if (onShift) {
    hdr += "\n🟢 На смене" + (lastEv ? " с " + lastEv.when : "");
    const myActive = autoRows().filter(function (r) {
      return String(r[A.WORKER-1]).trim() === user.name && String(r[A.STATUS-1]).trim() === "в работе";
    });
    myActive.forEach(function (r) {
      menu.push([{ text: "↩️ Вернуться к этапу: " + (r[A.PLATE-1] || r[A.ID-1]), callback_data: "resume_stage:" + r[A.ID-1] }]);
    });
    const queue = autoRows().filter(function (r) { return String(r[A.STATUS-1]).trim() === "в очереди"; });
    if (queue.length) {
      hdr += "\n🚗 В очереди: " + queue.length + " — выбери машину:";
      queue.slice(0, 12).forEach(function (r) {
        let label = (r[A.MODEL-1] || "?") + " — " + (r[A.PLATE-1] || "без номера");
        if (r[A.FLAG-1]) label = "⚠️ " + label;
        menu.push([{ text: "🚗 " + label, callback_data: "take:" + r[A.ID-1] }]);
      });
    } else {
      hdr += "\n🚗 Очередь пуста.";
    }
    menu.push([{ text: "🔄 Обновить список машин", callback_data: "refresh" }]);
    menu.push([{ text: "📋 Мои машины", callback_data: "my" }]);
    if (isReception(user)) {
      menu.push([{ text: "🙋 Приём клиента", callback_data: "client" }]);
      menu.push([{ text: "💵 Касса (нал)", callback_data: "cash" }]);
      menu.push([{ text: "💳 Принять картой", callback_data: "card_add" }]);
      menu.push([{ text: "📦 Готовы к выдаче", callback_data: "ready" }]);
    }
    menu.push([{ text: "☕ Ушёл на обед", callback_data: "sh_brk" },
               { text: "🔴 Ушёл с работы", callback_data: "sh_out" }]);
  } else if (onBreak) {
    hdr += "\n☕ На перерыве с " + lastEv.when;
    menu.push([{ text: "↩️ Вернулся с обеда", callback_data: "sh_back" },
               { text: "🔴 Ушёл с работы", callback_data: "sh_out" }]);
  } else {
    hdr += "\n🔴 Не на смене";
    menu.push([{ text: "🟢 Пришёл на работу", callback_data: "sh_in" }]);
  }

  menu.push([{ text: "💰 Моя зарплата", callback_data: "mysalary" }]);

  if (onShift) {
    const busy = autoRows().some(function (r) {
      return String(r[A.WORKER-1]).trim() === user.name && String(r[A.STATUS-1]).trim() === "в работе";
    });
    if (busy) clearWaiting(chatId); else markWaiting(chatId);
  } else clearWaiting(chatId);

  sendMenu(chatId, hdr, { inline_keyboard: menu });
}


// ═══════════════════ ВХОДЯЩИЕ ═══════════════════
function doPost(e) {
  try {
    const u = JSON.parse(e.postData.contents);
    if (u.update_id != null) {
      const key = "upd_" + u.update_id;
      const props = PropertiesService.getScriptProperties();
      if (props.getProperty(key)) return HtmlService.createHtmlOutput("DUP");
      props.setProperty(key, "1");
    }
    if (u.message) onMessage(u.message);
    if (u.callback_query) onCallback(u.callback_query);
  } catch (err) { Logger.log("ERR: " + err.stack); }
  return HtmlService.createHtmlOutput("OK");
}
function doGet() { return HtmlService.createHtmlOutput("KRAKEN OK"); }


function onMessage(msg) {
  resetCache();
  const chatId = msg.chat.id;
  const text = String(msg.text || "").trim();
  const user = getStaffByTelegram(chatId);

  // ── Фото до/после — забираем file_id ДО удаления (он валиден и после)
  if (msg.photo && msg.photo.length) {
    if (!user) { send(chatId, "Сначала введите PIN."); return; }
    if (!user.active) { send(chatId, "⛔ Доступ закрыт."); return; }
    if (handleChecklistPhoto(chatId, msg, user)) { return; }
    if (handlePhotoInput(chatId, msg, user)) {
      if (msg.message_id) tg("deleteMessage", { chat_id: chatId, message_id: msg.message_id });
      return;
    }
  }

  // Чистим сообщение пользователя (PIN, суммы, гео, фото)
  if (msg.message_id) {
    tg("deleteMessage", { chat_id: chatId, message_id: msg.message_id });
  }

  // ── Геолокация пришла?
  if (msg.location) {
    if (!user) { send(chatId, "Сначала введите PIN."); return; }
    if (!user.active) { send(chatId, "⛔ Доступ закрыт. Обратитесь к руководителю."); return; }
    handleGeoArrival(chatId, user, msg.location.latitude, msg.location.longitude);
    return;
  }

  if (text === "/start" || text === "/menu" || text === "меню") {
    if (!user) { send(chatId, "🐙 KRAKEN\nВведите ваш PIN-код:"); return; }
    if (!user.active) { send(chatId, "⛔ Доступ закрыт. Обратитесь к руководителю."); return; }
    // Сброс трекинга прошлого экрана — чтобы меню точно нарисовалось заново, а не «залипло».
    const props0 = PropertiesService.getScriptProperties();
    const prev0 = props0.getProperty("lastmsg_" + chatId);
    if (prev0) { tg("deleteMessage", { chat_id: chatId, message_id: prev0 }); props0.deleteProperty("lastmsg_" + chatId); props0.deleteProperty("lastmsgkind_" + chatId); }
    showMainMenu(chatId, user);
    return;
  }

  if (!user) {
    const found = getStaffByPin(text);
    if (!found) { send(chatId, "❌ Неверный PIN. Попробуйте ещё раз:"); return; }
    if (!found.active) { send(chatId, "⛔ Доступ закрыт. Обратитесь к руководителю."); return; }
    bindTelegram(text, chatId);
    showMainMenu(chatId, found);
    return;
  }

  if (!user.active) { send(chatId, "⛔ Доступ закрыт. Обратитесь к руководителю."); return; }

  if (handleTextInput(chatId, text, user)) return;

  return;
}


function onCallback(q) {
  // Мгновенно подтверждаем нажатие Telegram, ДО любой тяжёлой работы с Google —
  // иначе запрос "протухает" (query too old) и кнопку приходится жать повторно.
  try { tg("answerCallbackQuery", { callback_query_id: q.id, text: "" }); } catch (e) {}
  resetCache();
  const chatId = q.message.chat.id;
  const user = getStaffByTelegram(chatId);
  const parts = String(q.data).split(":");
  const action = parts[0];

  if (!user) { answer(q.id); return; }
  if (!user.active) { answer(q.id, "Доступ закрыт"); send(chatId, "⛔ Доступ закрыт. Обратитесь к руководителю."); return; }

  const ALWAYS = ["menu", "mysalary", "mysalary_full", "shift", "sh_in", "sh_out", "sh_brk", "sh_back",
                  "req_car", "my_grants", "g_take", "g_stage", "g_start", "g_finish",
                  "stpause", "stresume", "resume_stage", "finish", "cancel",
                  "help", "help_who", "help_yes", "help_no",
                  "photo_before", "photo_after", "photo_done", "chk_skip", "noop"];
  const ADMIN_ONLY = ["payroll", "payall", "paypart", "company", "summary", "sum_hours", "daystats",
                      "admin", "staff", "staff_ban", "staff_unban", "exp_add", "inc_add",
                      "collect", "collect_all", "collect_man", "areset", "del", "delyes",
                      "contract", "appr", "appr_car", "appr_rate", "testreset", "testreset_yes",
                      "gpull", "undo_menu", "undo", "unissue"];

  try {
    if (ADMIN_ONLY.indexOf(action) !== -1 && !isAdmin(user)) { answer(q.id, "Только для руководителя"); return; }

    const needsShift = (ALWAYS.indexOf(action) === -1) && (ADMIN_ONLY.indexOf(action) === -1);
    if (needsShift && !isContractor(user) && !isOnShift(user.name) && !isAdmin(user)) {
      answer(q.id, "Ты не на смене");
      send(chatId, "🔴 Ты не на смене. Сначала отметься «Пришёл на работу».", {
        inline_keyboard: [[{ text: "🟢 Пришёл на работу", callback_data: "sh_in" }], [{ text: "⬅️ Меню", callback_data: "menu" }]] });
      return;
    }

    routeCallback(chatId, user, action, parts, q.id);
  } catch (err) {
    Logger.log("CALLBACK ERR: " + (err && err.stack ? err.stack : err));
    answer(q.id);
    send(chatId, "⚠️ Связь подвисла, действие могло не отобразиться. Открой меню и проверь.",
      { inline_keyboard: [[{ text: "⬅️ В меню", callback_data: "menu" }]] });
  }
}


// ═══════════════════ РОУТЕР ═══════════════════
function routeCallback(chatId, user, action, parts, qid) {
  switch (action) {
    case "menu":     answer(qid); clearInputWaits(chatId); showMainMenu(chatId, user); return;
    case "refresh":  answer(qid, "Читаю папку..."); send(chatId, syncQueue()); showMainMenu(chatId, user); return;
    case "queue":    answer(qid); showQueue(chatId); return;
    case "my":       answer(qid); showMy(chatId, user); return;
    case "ready":    answer(qid); showReady(chatId, user); return;
    case "admin":    answer(qid); showAdmin(chatId); return;
    case "staff":    answer(qid); showStaff(chatId, user); return;

    case "take":     answer(qid); chooseStage(chatId, user, parts[1]); return;
    case "stage":    answer(qid); choosePlan(chatId, user, parts[1], parts[2]); return;
    case "start":    answer(qid, "Старт!"); startStage(chatId, user, parts[1], parts[2], parts[3]); return;
    case "finish":   answer(qid, "Готово!"); finishStage(chatId, user, parts[1]); return;
        case "chk_skip":  answer(qid); checklistSkipAsk(chatId, user, parts[1]); return;
    case "stpause":  answer(qid, "Пауза"); stagePause(chatId, user, parts[1]); return;
    case "stresume": answer(qid, "Продолжаем"); stageResume(chatId, user, parts[1]); return;
    case "resume_stage": answer(qid); resumeStageScreen(chatId, user, parts[1]); return;
    case "cancel":   answer(qid, "Отменено"); cancelStage(chatId, user, parts[1]); return;
    case "issue":    answer(qid); issueCarAsk(chatId, user, parts[1]); return;
    case "areset":   answer(qid, "Сброшено"); adminReset(chatId, user, parts[1]); return;
    case "gpull":         answer(qid, "Тяну из Google..."); pullFromGoogleAsk(chatId, user); return;
    case "testreset":     answer(qid); testResetAsk(chatId, user); return;
    case "testreset_yes": answer(qid, "Чищу..."); testResetDo(chatId, user); return;
    case "del":      answer(qid); delAsk(chatId, user, parts[1]); return;
    case "delyes":   answer(qid, "Удалено"); delDo(chatId, user, parts[1]); return;
    case "contract": answer(qid); contractAsk(chatId, user, parts[1]); return;

    case "shift":    answer(qid); showShift(chatId, user); return;
    case "sh_in":    answer(qid); shiftInStart(chatId, user); return;
    case "sh_out":   answer(qid, "Ушёл"); shiftOut(chatId, user); return;
    case "sh_brk":   answer(qid, "Перерыв"); shiftBreak(chatId, user); return;
    case "sh_back":  answer(qid, "В работе"); shiftBack(chatId, user); return;

    case "client":      answer(qid); showClient(chatId, user); return;
    case "client_take": answer(qid, "Принял"); clientTake(chatId, user); return;
    case "client_free": answer(qid, "Освободился"); clientFree(chatId, user); return;

    case "cash":         answer(qid); showCash(chatId, user); return;
    case "cash_add":     answer(qid); cashAddAsk(chatId, user); return;
    case "card_add":     answer(qid); cardAddAsk(chatId, user); return;
    case "company":      answer(qid); showCompany(chatId, user); return;
    case "exp_add":      answer(qid); expenseAsk(chatId, user); return;
    case "inc_add":      answer(qid); incomeAsk(chatId, user); return;
    case "collect":      answer(qid); collectAsk(chatId, user); return;
    case "collect_all":  answer(qid, "Забираю"); collectAll(chatId, user); return;
    case "collect_man":  answer(qid); collectManual(chatId, user); return;

    case "pay_cash": answer(qid, "Нал"); issuePayCash(chatId, user, parts[1]); return;
    case "pay_card": answer(qid, "Карта"); issuePayCard(chatId, user, parts[1]); return;
    case "pay_man":  answer(qid); issuePayManual(chatId, user, parts[1]); return;
    case "pay_extra": answer(qid); issuePayExtra(chatId, user, parts[1]); return;

    case "mysalary": answer(qid); showMySalary(chatId, user); return;
    case "mysalary_full": answer(qid); PropertiesService.getScriptProperties().setProperty("salfull_" + chatId, "1"); showMySalary(chatId, user); return;
    case "payroll":  answer(qid); showPayroll(chatId, user); return;
    case "payall":   answer(qid, "Выдаю..."); payAll(chatId, user, parts[1]); return;
    case "paypart":  answer(qid); payPartAsk(chatId, user, parts[1]); return;

    case "summary":   answer(qid); showSummary(chatId, user); return;
    case "sum_hours": answer(qid); showHoursSummary(chatId, user); return;
        case "daystats": answer(qid); showDayStats(chatId, user, parts[1]); return;
        case "noop": answer(qid); return;

    case "req_car":    answer(qid, "Запрос отправлен"); contractorRequest(chatId, user); return;
    case "my_grants":  answer(qid); showGrants(chatId, user); return;
    case "g_take":     answer(qid); grantChooseStage(chatId, user, parts[1]); return;
    case "g_stage":    answer(qid); grantChoosePlan(chatId, user, parts[1], parts[2]); return;
    case "g_start":    answer(qid, "Старт!"); grantStartStage(chatId, user, parts[1], parts[2], parts[3]); return;
    case "g_finish":   answer(qid, "Готово!"); grantFinishStage(chatId, user, parts[1]); return;
    case "appr":       answer(qid); approveList(chatId, user, parts[1]); return;
    case "appr_car":   answer(qid); approveRateAsk(chatId, user, parts[1], parts[2]); return;

    case "staff_ban":   answer(qid, "Заблокирован"); staffBan(chatId, user, parts[1]); return;
    case "staff_unban": answer(qid, "Разблокирован"); staffUnban(chatId, user, parts[1]); return;

    // ── НОВОЕ v5 ──
    case "undo_menu": answer(qid); showUndo(chatId, user); return;
    case "undo":      answer(qid, "Сторно"); undoOp(chatId, user, parts[1], parts[2]); return;
    case "unissue":   answer(qid); unissueCar(chatId, user, parts[1]); return;
    case "photo_before": answer(qid); photoAsk(chatId, user, parts[1], "до"); return;
    case "photo_after":  answer(qid); photoAsk(chatId, user, parts[1], "после"); return;
    case "photo_done":   answer(qid); photoDone(chatId, user, parts[1], parts[2]); return;
    case "help":       answer(qid); helpAsk(chatId, user, parts[1]); return;
    case "help_who":   answer(qid); helpAmountAsk(chatId, user, parts[1], parts[2]); return;
    case "help_yes":   answer(qid, "Принято"); helpAccept(chatId, user, parts[1], parts[2]); return;
    case "help_no":    answer(qid, "Отклонено"); helpDecline(chatId, user, parts[1], parts[2]); return;

    default: answer(qid); return;
  }
}


// ═══════════════════ ОЧЕРЕДЬ / ЭТАПЫ ═══════════════════
function showQueue(chatId) {
  const cars = autoRows().filter(function (r) { return String(r[A.STATUS-1]).trim() === "в очереди"; });
  if (!cars.length) { send(chatId, "🚗 Очередь пуста. Нажми «🔄 Обновить».", backMenu()); return; }
  const kb = cars.map(function (r) {
    let label = (r[A.MODEL-1] || "?") + " — " + (r[A.PLATE-1] || "без номера");
    if (r[A.FLAG-1]) label = "⚠️ " + label;
    return [{ text: label, callback_data: "take:" + r[A.ID-1] }];
  });
  kb.push([{ text: "⬅️ В меню", callback_data: "menu" }]);
  send(chatId, "🚗 Машины в очереди (" + cars.length + "). Выбери:", { inline_keyboard: kb });
}
function backMenu() { return { inline_keyboard: [[{ text: "⬅️ В меню", callback_data: "menu" }]] }; }

function chooseStage(chatId, user, carId) {
  const car = findCar(carId);
  if (!car) { send(chatId, "Машина не найдена.", backMenu()); return; }
  if (String(car[A.STATUS-1]).trim() !== "в очереди") { send(chatId, "Эту машину уже взяли. Обнови очередь.", backMenu()); return; }
  const stages = availableStages(car);
  if (!stages.length) { send(chatId, "Все этапы по этой машине сделаны.", backMenu()); return; }
  // ОПТИМИЗАЦИЯ UX: убран экран «за сколько планируешь» (choosePlan) — мёртвый ввод,
  // факт всё равно меряется по часам. Кнопка этапа ведёт сразу на старт (минус тап).
  const kb = stages.map(function (st) { return [{ text: "▶️ " + stageDisplay(st), callback_data: "start:" + carId + ":" + stageCode(st) }]; });
  kb.push([{ text: "⬅️ Отмена", callback_data: "queue" }]);
  send(chatId, "🚗 " + (car[A.MODEL-1] || carId) + " — " + (car[A.PLATE-1] || "") + "\n\n" +
    stagesOverview(carId) + "\n\nКакой этап делаешь? (жми — сразу старт)", { inline_keyboard: kb });
}
// Оставлено для обратной совместимости со старыми сообщениями (callback stage:...):
// раньше спрашивало план, теперь сразу стартует.
function choosePlan(chatId, user, carId, stageCodeStr) {
  startStage(chatId, user, carId, stageCodeStr, null);
}
function startStage(chatId, user, carId, stageCodeStr, timeCodeStr) {
  const stage = stageName(stageCodeStr);
  const plan = (timeCodeStr === null || timeCodeStr === undefined || timeCodeStr === "")
    ? "—" : timeName(timeCodeStr);
  const car = findCar(carId);
  if (!car) { send(chatId, "Машина не найдена.", backMenu()); return; }
  if (String(car[A.STATUS-1]).trim() !== "в очереди") { send(chatId, "⚠️ Машину уже взяли.", backMenu()); return; }
  // Первый этап по машине — требуем фото ДО
  if (doneStages(carId).length === 0 && photoCount(carId, "до") < MIN_PHOTOS) {
    const have = photoCount(carId, "до");
    photoAsk(chatId, user, carId, "до");
    return;
  }
  const row = car._row;
  setCell(row, A.STATUS, "в работе"); setCell(row, A.STAGE, stage);
  setCell(row, A.WORKER, user.name); setCell(row, A.START, now()); setCell(row, A.PLAN, plan);
  // TYPE не трогаем — там код услуги из протокола (нужен для этапов и чеклистов).
  clearWaiting(chatId);
  SpreadsheetApp.flush();
  sendStageScreen(chatId, user, carId, "▶️ СТАРТ");
}
// Экран активного этапа: Финиш крупно, Помощник, Фото, редкое ниже
function sendStageScreen(chatId, user, carId, headline) {
  const car = findCar(carId);
  if (!car) { send(chatId, "Машина не найдена.", backMenu()); return; }
  const stage = String(car[A.STAGE-1]).trim(), plan = String(car[A.PLAN-1]).trim();
  const startStr = String(car[A.START-1]).trim();

  // ── ЖИВОЙ СЧЁТЧИК (обновляется при каждом заходе на экран / кнопке 🔄) ──
  const est = estimateStagePay(user.name, stage, car);
  let elapsed = startStr ? minutesBetween(startStr, now()) : "";
  const paused = stagePausedMinutes(carId);
  if (typeof elapsed === "number" && paused > 0) elapsed = Math.max(0, elapsed - paused);
  const best = personalBestMin(user.name, stage);

  let live = "";
  if (est !== null && est !== undefined) live += "💰 За этот этап: ~" + est + " zł\n";
  if (elapsed !== "") {
    live += "⏱️ Идёт: " + elapsed + " мин";
    if (paused > 0) live += " (пауза " + paused + " мин не в счёт ✅)";
    live += "\n";
  }
  if (best !== null) {
    live += "⚡️ Твой рекорд по «" + stageDisplay(stage) + "»: " + best + " мин";
    if (typeof elapsed === "number") {
      if (elapsed < best) live += "  🔥 идёшь на рекорд!";
      else if (elapsed <= best + 5) live += "  (почти вровень)";
    }
    live += "\n";
  } else {
    live += "⚡️ Рекорд по «" + stageDisplay(stage) + "» ещё не поставлен — этот станет первым.\n";
  }

  const finishCb = isContractor(user) ? ("g_finish:" + carId) : ("finish:" + carId);
  const kb = [[{ text: "✅ ФИНИШ этапа", callback_data: finishCb }],
              [{ text: "🔄 Обновить счётчик", callback_data: "resume_stage:" + carId }],
              [{ text: "🤝 Позвать помощника", callback_data: "help:" + carId }],
              [{ text: "📸 Фото до", callback_data: "photo_before:" + carId },
               { text: "📸 Фото после", callback_data: "photo_after:" + carId }],
              [{ text: "⏸ Пауза", callback_data: "stpause:" + carId },
               { text: "⚠️ Мисклик/Отмена", callback_data: "cancel:" + carId }]];
  if (isReception(user)) {
    kb.push([{ text: "🙋 Клиент", callback_data: "client" },
             { text: "💵 Касса", callback_data: "cash" }]);
    kb.push([{ text: "💳 Картой", callback_data: "card_add" },
             { text: "📦 Выдача", callback_data: "ready" }]);
  }
  kb.push([{ text: "⬅️ В меню", callback_data: "menu" }]);
  send(chatId, headline + ": " + stageDisplay(stage) + "\n🚗 " + (car[A.MODEL-1] || carId) +
    "\n\n" + live +
    "\n" + stagesOverview(carId) +
    "\n\nКак закончишь — жми ФИНИШ. Нужно отойти — жми «Пауза»." +
    (isReception(user) ? "\nМожешь параллельно принять/рассчитать клиента — этап не собьётся." : ""),
    { inline_keyboard: kb });
}
function resumeStageScreen(chatId, user, carId) {
  const car = findCar(carId);
  if (!car) { send(chatId, "Машина не найдена.", backMenu()); return; }
  if (String(car[A.WORKER-1]).trim() !== user.name || String(car[A.STATUS-1]).trim() !== "в работе") {
    send(chatId, "Этот этап уже не активен.", backMenu()); return;
  }
  sendStageScreen(chatId, user, carId, "▶️ ЭТАП В РАБОТЕ");
}

// ═══════════════════ ЧЕК-ЛИСТ ЭТАПА (фото по пунктам) ═══════════════════
// После финиша этапа работник проходит чек-лист: по каждому пункту делает фото
// (или пропускает с указанием причины). Фото сохраняются на Drive вместе с машиной.

// Лист "Чеклист": Когда | Машина | Услуга | Этап | Пункт | Кто | Статус(фото/пропуск) | Причина
function getChecklistSheet() {
  let sh = db().getSheetByName("Чеклист");
  if (!sh) {
    sh = db().insertSheet("Чеклист");
    sh.getRange(1,1,1,8).setValues([["Когда","Машина","Услуга","Этап","Пункт","Кто","Статус","Причина"]]);
    sh.setFrozenRows(1);
  }
  return sh;
}

// Запустить чек-лист по этапу. Возвращает true, если чек-лист есть и запущен.
function startChecklist(chatId, user, carId, stage) {
  const car = findCar(carId);
  if (!car) return false;
  // stage — это ключ "КОД|Этап"; чек-лист берём именно для его услуги.
  const p = parseStageKey(stage);
  const items = stageChecklistByKey(stage);
  if (!items.length) return false; // нет чек-листа — обычный финиш
  const state = { carId: carId, stage: stage, stageName: p.stage, code: p.code, items: items, idx: 0, who: user.name };
  PropertiesService.getScriptProperties()
    .setProperty("await_checklist_" + chatId, JSON.stringify(state));
  sendChecklistItem(chatId, state);
  return true;
}

// Показать текущий пункт чек-листа.
function sendChecklistItem(chatId, state) {
  const total = state.items.length, n = state.idx + 1;
  const item = state.items[state.idx];
  const car = findCar(state.carId);
  const model = car ? (car[A.MODEL-1] || state.carId) : state.carId;
  send(chatId,
    "📋 Чек-лист · этап «" + (state.stageName || state.stage) + "»\n" +
    "Пункт " + n + " из " + total + ":\n\n👉 " + item + "\n\n" +
    "📸 Сделай фото этого пункта на машине " + model + " и пришли сюда.\n" +
    "Если по этому пункту фото не нужно — жми «Пропустить».",
    { inline_keyboard: [
      [{ text: "⏭ Пропустить пункт", callback_data: "chk_skip:" + state.carId }],
      [{ text: "⬅️ Назад к этапу", callback_data: "resume_stage:" + state.carId }] ] });
}

// Перейти к следующему пункту или завершить чек-лист.
function checklistAdvance(chatId, user) {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty("await_checklist_" + chatId);
  if (!raw) return;
  let state; try { state = JSON.parse(raw); } catch (e) { props.deleteProperty("await_checklist_" + chatId); return; }
  state.idx++;
  if (state.idx >= state.items.length) {
    // чек-лист пройден — реально закрываем этап
    props.deleteProperty("await_checklist_" + chatId);
    send(chatId, "✅ Чек-лист по этапу «" + (state.stageName || state.stage) + "» пройден. Закрываю этап…");
    doFinishStage(chatId, user, state.carId);
    return;
  }
  props.setProperty("await_checklist_" + chatId, JSON.stringify(state));
  sendChecklistItem(chatId, state);
}

// Обработка фото для пункта чек-листа. Возвращает true, если фото поглощено чек-листом.
function handleChecklistPhoto(chatId, msg, user) {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty("await_checklist_" + chatId);
  if (!raw) return false;
  if (!msg.photo || !msg.photo.length) return false;
  let state; try { state = JSON.parse(raw); } catch (e) { return false; }
  const item = state.items[state.idx];
  const phase = "чек · " + (state.stageName || state.stage) + " · " + item;
  const best = msg.photo[msg.photo.length - 1];
  // кладём фото в общую очередь на Drive (папка машины) с понятной фазой
  getPhotoSheet().appendRow([now(), state.carId, phase, user.name, "", "очередь"]);
  const qRaw = props.getProperty("photo_queue") || "[]";
  let q; try { q = JSON.parse(qRaw); } catch (e) { q = []; }
  q.push({ fileId: best.file_id, carId: state.carId, phase: phase, who: user.name, when: now() });
  if (q.length > 200) q = q.slice(q.length - 200);
  props.setProperty("photo_queue", JSON.stringify(q));
  // отметка в листе Чеклист
  getChecklistSheet().appendRow([now(), state.carId, state.code, state.stage, item, user.name, "фото", ""]);
  // Удаляем присланное фото из чата, чтобы экран оставался чистым.
  if (msg.message_id) tg("deleteMessage", { chat_id: chatId, message_id: msg.message_id });
  checklistAdvance(chatId, user);
  return true;
}

// Пропуск пункта: спросить причину текстом.
function checklistSkipAsk(chatId, user, carId) {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty("await_checklist_" + chatId);
  if (!raw) { send(chatId, "Чек-лист не активен.", backMenu()); return; }
  props.setProperty("await_chkskip_" + chatId, "1");
  send(chatId, "✍️ Напиши коротко причину, почему по этому пункту нет фото (одним сообщением).");
}

// Обработка текста-причины пропуска. true если поглощено.
function handleChecklistSkip(chatId, text, user) {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty("await_chkskip_" + chatId)) return false;
  const raw = props.getProperty("await_checklist_" + chatId);
  if (!raw) { props.deleteProperty("await_chkskip_" + chatId); return false; }
  let state; try { state = JSON.parse(raw); } catch (e) { props.deleteProperty("await_chkskip_" + chatId); return false; }
  props.deleteProperty("await_chkskip_" + chatId);
  const item = state.items[state.idx];
  getChecklistSheet().appendRow([now(), state.carId, state.code, state.stage, item, user.name, "пропуск", text]);
  checklistAdvance(chatId, user);
  return true;
}

// Понятное сообщение при несовпадении мастера на этапе.
// Пусто = этап уже закрылся/сорвался (не «другой мастер»). Иначе — реально чужой.
function ownerMismatchMsg(car) {
  const w = String(car[A.WORKER-1]).trim();
  if (!w) return "⚠️ Этот этап уже закрыт или сброшен. Возьми машину заново из очереди.";
  return "⚠️ Этот этап сейчас за мастером " + w + ". Обнови очередь.";
}
function finishStage(chatId, user, carId) {
  const car = findCar(carId);
  if (!car) { send(chatId, "Машина не найдена.", backMenu()); return; }
  if (String(car[A.WORKER-1]).trim() !== user.name) { send(chatId, ownerMismatchMsg(car), backMenu()); return; }
  const stage = String(car[A.STAGE-1]).trim();
  // Сначала чек-лист этапа (фото по пунктам). Есть чек-лист — проходим его,
  // реальное закрытие произойдёт в doFinishStage после прохождения.
  if (startChecklist(chatId, user, carId, stage)) return;
  doFinishStage(chatId, user, carId);
}

function doFinishStage(chatId, user, carId) {
  const car = findCar(carId);
  if (!car) { send(chatId, "Машина не найдена.", backMenu()); return; }
  if (String(car[A.WORKER-1]).trim() !== user.name) { send(chatId, ownerMismatchMsg(car), backMenu()); return; }
  const stage = String(car[A.STAGE-1]).trim(), startStr = String(car[A.START-1]).trim(), plan = String(car[A.PLAN-1]).trim();
  // Закроет ли этот финиш машину? (мойка-услуга ИЛИ последний недостающий этап цепочки)
  {
    const willClose = serviceAllDone(carId, stage);
    if (willClose && photoCount(carId, "после") < MIN_PHOTOS) {
      const have = photoCount(carId, "после");
      send(chatId, "📸 Это финальный этап. Нужно минимум " + MIN_PHOTOS + " фото ПОСЛЕ (принято " + have + ").\nНажми «📸 Фото после», пришли снимки, потом финишируй.",
        { inline_keyboard: [[{ text: "📸 Фото после", callback_data: "photo_after:" + carId }],
                            [{ text: "⬅️ Назад к этапу", callback_data: "resume_stage:" + carId }]] });
      return;
    }
  }
  let factMin = startStr ? minutesBetween(startStr, now()) : "";
  // Защита от двойного закрытия: если этот этап по машине уже в Логах — не дублируем.
  if (doneStages(carId).indexOf(stage) !== -1) {
    const row0 = car._row;
    setCell(row0, A.WORKER, ""); setCell(row0, A.STAGE, ""); setCell(row0, A.START, ""); setCell(row0, A.PLAN, "");
    send(chatId, "⚠️ Этот этап уже был закрыт по этой машине.", backMenu());
    return;
  }
  const pausedMin = stagePausedMinutes(carId);
  if (typeof factMin === "number" && pausedMin > 0) factMin = Math.max(0, factMin - pausedMin);
  clearStagePause(carId);

  // Рекорд СЧИТАЕМ ДО записи новой строки (иначе она сама попадёт в выборку).
  const prevBest = personalBestMin(user.name, stage);
  let recordNote = "";
  if (typeof factMin === "number" && factMin > 0) {
    if (prevBest === null) {
      recordNote = "\n⚡️ Первый твой замер по «" + stageDisplay(stage) + "» — это теперь твой рекорд: " + factMin + " мин.";
    } else if (factMin < prevBest) {
      recordNote = "\n🔥 НОВЫЙ РЕКОРД по «" + stageDisplay(stage) + "»! На " + (prevBest - factMin) + " мин быстрее (было " + prevBest + ").";
    } else if (factMin <= prevBest + 5) {
      recordNote = "\n⚡️ Почти вровень с рекордом (" + prevBest + " мин).";
    } else {
      recordNote = "\n⏱ Чуть медленнее обычного (рекорд " + prevBest + " мин).";
    }
  }

  // ── ОПЛАТА ЗА УСЛУГУ, НЕ ЗА ЭТАП ──
  // Деньги начисляются один раз — когда закрыт ПОСЛЕДНИЙ этап услуги.
  // Процент берётся от цены этой услуги, платится тому, кто закрыл последний этап.
  let pay = 0;
  const _p = (typeof parseStageKey === "function") ? parseStageKey(stage) : { code: "", stage: stage };
  if (serviceLastStageDone(car, stage)) {
    pay = calcPay(user.name, stage, car);
  }
  // деление с помощниками
  const givenToHelpers = pay > 0 ? settleHelpOnFinish(carId, stage, user.name, pay) : 0;
  const payMaster = Math.round((pay - givenToHelpers) * 100) / 100;
  const pauseNote = (pausedMin > 0 ? "пауза " + pausedMin + " мин" : "") +
                    (givenToHelpers > 0 ? (pausedMin > 0 ? " · " : "") + "помощникам " + givenToHelpers + " zł" : "");
  sheet("Логи").appendRow([now(), carId, car[A.PLATE-1], user.name, stage, plan, startStr, now(), factMin, payMaster, pauseNote]);
  bump("Логи");
  pay = payMaster;

  const done = doneStages(carId);
  const carClosed = serviceAllDone(carId, stage);
  const row = car._row;
  setCell(row, A.WORKER, ""); setCell(row, A.STAGE, ""); setCell(row, A.START, ""); setCell(row, A.PLAN, "");

  if (carClosed) {
    setCell(row, A.STATUS, "готова к выдаче");
    SpreadsheetApp.flush();
    send(chatId, "✅ Этап «" + stageDisplay(stage) + "» закрыт.\n💰 Начислено: " + pay + " zł\n⏱ Факт: " + factMin +
      " мин" + recordNote + "\n\n🏁 Все этапы сделаны — машина ГОТОВА К ВЫДАЧЕ.", backMenu());
    return;
  }

  setCell(row, A.STATUS, "в очереди");
  // Раньше: send(итог) → sleep(400) → nextWorkScreen (второй send затирал итог).
  // Теперь показываем начисление шапкой прямо в экране «что дальше» — один запрос.
  const finishNote = "✅ Этап «" + stageDisplay(stage) + "» закрыт · 💰 " + pay + " zł · ⏱ " + factMin + " мин" +
    recordNote + "\n" + stagesOverview(carId);
  nextWorkScreen(chatId, user, carId, finishNote);
}

function nextWorkScreen(chatId, user, justCarId, headNote) {
  const kb = [];
  let txt = (headNote ? headNote + "\n\n" : "") + "➡️ ЧТО ДАЛЬШЕ?";
  if (justCarId) {
    const fresh = findCar(justCarId);
    if (fresh && String(fresh[A.STATUS-1]).trim() === "в очереди") {
      const nextStages = availableStages(fresh);
      if (nextStages.length) {
        txt += "\n\nПо этой машине (" + (fresh[A.MODEL-1] || justCarId) + ") осталось:";
        nextStages.forEach(function (st) {
          kb.push([{ text: "▶️ " + stageDisplay(st), callback_data: "stage:" + justCarId + ":" + stageCode(st) }]);
        });
      }
    }
  }
  const queue = autoRows().filter(function (r) {
    return String(r[A.STATUS-1]).trim() === "в очереди" &&
           String(r[A.ID-1]).trim() !== String(justCarId).trim();
  });
  if (queue.length) {
    txt += "\n\nДругие машины в очереди (" + queue.length + "):";
    queue.forEach(function (r) {
      let label = (r[A.MODEL-1] || "?") + " — " + (r[A.PLATE-1] || "без номера");
      if (r[A.FLAG-1]) label = "⚠️ " + label;
      kb.push([{ text: "🚗 " + label, callback_data: "take:" + r[A.ID-1] }]);
    });
  }
  if (!kb.length) txt += "\n\nОчередь пуста — можно отдохнуть.";
  kb.push([{ text: "☕ Перерыв (обед)", callback_data: "sh_brk" }]);
  kb.push([{ text: "⬅️ В меню", callback_data: "menu" }]);
  markWaiting(chatId);
  send(chatId, txt, { inline_keyboard: kb });
}
function cancelStage(chatId, user, carId) {
  const car = findCar(carId);
  if (!car) return;
  if (String(car[A.WORKER-1]).trim() !== user.name) { send(chatId, "⚠️ Это не твой этап.", backMenu()); return; }
  const stageForHelp = String(car[A.STAGE-1]).trim();
  cancelHelpForStage(carId, stageForHelp, user.name);   // аннулируем помощь
  const row = car._row;
  setCell(row, A.STATUS, "в очереди"); setCell(row, A.STAGE, ""); setCell(row, A.WORKER, "");
  setCell(row, A.START, ""); setCell(row, A.PLAN, "");
  clearStagePause(carId);
  SpreadsheetApp.flush();
  send(chatId, "↩️ Отменено. Машина в очереди, таймер стёрт.", backMenu());
}

// ── ПАУЗА ЭТАПА
function stagePausedMinutes(carId) {
  const props = PropertiesService.getScriptProperties();
  let sum = Number(props.getProperty("pausesum_" + carId)) || 0;
  const startedAt = props.getProperty("pausestart_" + carId);
  if (startedAt) {
    const m = minutesBetween(startedAt, now());
    if (typeof m === "number") sum += m;
  }
  return sum;
}
function clearStagePause(carId) {
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty("pausesum_" + carId);
  props.deleteProperty("pausestart_" + carId);
}
function stagePause(chatId, user, carId) {
  const car = findCar(carId);
  if (!car) { send(chatId, "Машина не найдена.", backMenu()); return; }
  if (String(car[A.WORKER-1]).trim() !== user.name) { send(chatId, "⚠️ Это не твой этап.", backMenu()); return; }
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty("pausestart_" + carId)) { showStagePaused(chatId, user, carId); return; }
  props.setProperty("pausestart_" + carId, now());
  clearWaiting(chatId);
  shiftLog(user.name, "перерыв", "", "");
  SpreadsheetApp.flush();
  showStagePaused(chatId, user, carId);
}
function showStagePaused(chatId, user, carId) {
  const car = findCar(carId);
  const stage = car ? String(car[A.STAGE-1]).trim() : "";
  send(chatId, "⏸ ПАУЗА по машине " + (car ? (car[A.MODEL-1] || carId) : carId) +
    "\nЭтап: " + stageDisplay(stage) + "\nВремя паузы не войдёт в факт.\n\nКогда вернёшься — жми «Продолжить».", {
    inline_keyboard: [[{ text: "▶️ Продолжить этап", callback_data: "stresume:" + carId }],
                      [{ text: "✅ Сразу ФИНИШ", callback_data: "finish:" + carId }]] });
}
function stageResume(chatId, user, carId) {
  const car = findCar(carId);
  if (!car) { send(chatId, "Машина не найдена.", backMenu()); return; }
  if (String(car[A.WORKER-1]).trim() !== user.name) { send(chatId, "⚠️ Это не твой этап.", backMenu()); return; }
  const props = PropertiesService.getScriptProperties();
  const startedAt = props.getProperty("pausestart_" + carId);
  if (startedAt) {
    const add = minutesBetween(startedAt, now());
    const prev = Number(props.getProperty("pausesum_" + carId)) || 0;
    props.setProperty("pausesum_" + carId, String(prev + (typeof add === "number" ? add : 0)));
    props.deleteProperty("pausestart_" + carId);
  }
  shiftLog(user.name, "возврат", "", "");
  SpreadsheetApp.flush();
  const stage = String(car[A.STAGE-1]).trim(), plan = String(car[A.PLAN-1]).trim();
  const paused = stagePausedMinutes(carId);
  send(chatId, "▶️ Продолжаем: " + stageDisplay(stage) + "\n🚗 " + (car[A.MODEL-1] || carId) +
    "\n⏸ всего в паузе: " + paused + " мин (не войдёт в факт)\n\nКак закончишь — жми ФИНИШ.", {
    inline_keyboard: [[{ text: "✅ ФИНИШ этапа", callback_data: "finish:" + carId }],
                      [{ text: "⏸ Пауза (отойти)", callback_data: "stpause:" + carId }],
                      [{ text: "⬅️ В меню", callback_data: "menu" }]] });
}
function showMy(chatId, user) {
  const all = autoRows().filter(function (r) { return String(r[A.STATUS-1]).trim() === "в работе"; });
  const mine = isAdmin(user) ? all
    : all.filter(function (r) { return String(r[A.WORKER-1]).trim() === user.name; });
  if (!mine.length) {
    send(chatId, isAdmin(user) ? "📋 Сейчас нет машин в работе." : "📋 У тебя нет машин в работе.", backMenu());
    return;
  }
  let txt = isAdmin(user) ? "📋 МАШИНЫ В РАБОТЕ (" + mine.length + ")\n" : "📋 ТВОИ МАШИНЫ (" + mine.length + ")\n";
  const kb = [];
  mine.forEach(function (r) {
    txt += "\n🚗 " + (r[A.MODEL-1] || r[A.ID-1]) + " — " + (r[A.PLATE-1] || "") +
           "\n   этап: " + r[A.STAGE-1] + " · " + (isAdmin(user) ? r[A.WORKER-1] + " · " : "") +
           "старт " + r[A.START-1] + " (план " + r[A.PLAN-1] + ")\n";
    kb.push([{ text: "▶️ Открыть этап: " + (r[A.PLATE-1] || r[A.ID-1]), callback_data: "resume_stage:" + r[A.ID-1] }]);
    if (!isAdmin(user)) {
      kb.push([{ text: "✅ ФИНИШ: " + (r[A.PLATE-1] || r[A.ID-1]), callback_data: "finish:" + r[A.ID-1] },
               { text: "⚠️", callback_data: "cancel:" + r[A.ID-1] }]);
    }
  });
  kb.push([{ text: "⬅️ В меню", callback_data: "menu" }]);
  send(chatId, txt, { inline_keyboard: kb });
}
function showReady(chatId, user) {
  if (!(isReception(user) || isAdmin(user))) { send(chatId, "Нет прав на выдачу.", backMenu()); return; }
  const ready = autoRows().filter(function (r) { return String(r[A.STATUS-1]).trim() === "готова к выдаче"; });
  if (!ready.length) { send(chatId, "📦 Готовых к выдаче нет.", backMenu()); return; }
  const kb = ready.map(function (r) {
    return [{ text: "🏁 Выдать: " + (r[A.MODEL-1] || r[A.ID-1]) + " — " + r[A.PLATE-1], callback_data: "issue:" + r[A.ID-1] }]; });
  kb.push([{ text: "⬅️ В меню", callback_data: "menu" }]);
  send(chatId, "📦 Готовы к выдаче (" + ready.length + "):", { inline_keyboard: kb });
}


// ═══════════════════ СМЕНЫ + ГЕО ═══════════════════
function showShift(chatId, user) {
  const last = lastShiftEvent(user.name);
  let state = "не на смене";
  if (last) {
    if (last.event === "пришёл" || last.event === "возврат") state = "на смене с " + last.when;
    else if (last.event === "перерыв") state = "на перерыве с " + last.when;
    else if (last.event === "ушёл") state = "не на смене (ушёл " + last.when + ")";
  }
  const kb = [];
  if (!last || last.event === "ушёл") kb.push([{ text: "🟢 Пришёл на работу", callback_data: "sh_in" }]);
  else if (last.event === "пришёл" || last.event === "возврат") {
    kb.push([{ text: "☕ Уйти на перерыв", callback_data: "sh_brk" }]);
    kb.push([{ text: "🔴 Ушёл с работы", callback_data: "sh_out" }]);
  } else if (last.event === "перерыв") {
    kb.push([{ text: "↩️ Вернулся с перерыва", callback_data: "sh_back" }]);
    kb.push([{ text: "🔴 Ушёл с работы", callback_data: "sh_out" }]);
  }
  kb.push([{ text: "⬅️ В меню", callback_data: "menu" }]);
  send(chatId, "🕐 УЧЁТ ВРЕМЕНИ — " + user.name + "\nСейчас: " + state, { inline_keyboard: kb });
}
function shiftInStart(chatId, user) {
  if (isOnShift(user.name)) { send(chatId, "Ты уже на смене."); showShift(chatId, user); return; }
  PropertiesService.getScriptProperties().setProperty("await_geo_" + chatId, "1");
  sendReplyKb(chatId,
    "📍 Чтобы отметить приход, отправь свою геолокацию (кнопка ниже).\nЭто подтверждает, что ты на месте.",
    { keyboard: [[{ text: "📍 Отправить геолокацию", request_location: true }]],
      resize_keyboard: true, one_time_keyboard: true });
}
function handleGeoArrival(chatId, user, lat, lon) {
  const props = PropertiesService.getScriptProperties();
  const waiting = props.getProperty("await_geo_" + chatId);
  props.deleteProperty("await_geo_" + chatId);
  if (!waiting) { removeReplyKb(chatId, "Принял геолокацию."); showMainMenu(chatId, user); return; }

  const geo = checkGeo(lat, lon);
  if (!geo.ok) {
    removeReplyKb(chatId, "❌ Ты не на территории сервиса (до точки ~" + geo.dist + " м, нужно ≤ " + geo.radius +
      " м).\nОтметка прихода НЕ засчитана. Подойди ближе и попробуй снова.");
    showShift(chatId, user);
    return;
  }
  const geoStr = (geo.noConfig ? "гео не настроено" : "✓ " + geo.dist + " м");
  shiftLog(user.name, "пришёл", geoStr, "");
  SpreadsheetApp.flush();

  const late = lateMinutes();
  if (late > 0) {
    PropertiesService.getScriptProperties().setProperty("await_late_" + chatId, String(late));
    removeReplyKb(chatId, "🟢 Приход отмечен: " + now() + "\n📍 " + geoStr +
      "\n\n⏰ Ты опоздал на ~" + late + " мин (смена с 9:00).\nНапиши причину опоздания одним сообщением:");
    notifyAdmin("⏰ " + user.name + " пришёл с опозданием ~" + late + " мин\n🕐 " + now() + "\n📍 " + geoStr);
    return;
  }
  removeReplyKb(chatId, "🟢 Приход отмечен: " + now() + "\n📍 " + geoStr);
  notifyAdmin("✅ " + user.name + " пришёл на работу\n🕐 " + now() + "\n📍 " + geoStr);
  showMainMenu(chatId, user);
}
function shiftOut(chatId, user) {
  const last = lastShiftEvent(user.name);
  if (!last || last.event === "ушёл") { send(chatId, "Ты и так не на смене."); showShift(chatId, user); return; }
  const early = earlyLeaveMinutes();
  if (early > 0) {
    PropertiesService.getScriptProperties().setProperty("await_early_" + chatId, String(early));
    send(chatId, "⏰ Сейчас " + now() + ", смена до 19:00 (раньше на ~" + early +
      " мин).\nНапиши причину раннего ухода одним сообщением — после этого смена закроется:");
    return;
  }
  doShiftOut(chatId, user, "");
}
function doShiftOut(chatId, user, reason) {
  const startStr = findShiftStart(user.name);
  const mins = startStr ? minutesBetween(startStr, now()) : "";
  shiftLog(user.name, "ушёл", "", mins);
  clearWaiting(chatId);
  if (reason) appendShiftComment(user.name, "ранний уход: " + reason);
  SpreadsheetApp.flush();
  const h = mins !== "" ? " (смена ≈ " + fmtDur(mins) + ")" : "";
  let adminMsg = "🔴 " + user.name + " ушёл с работы\n🕐 " + now() + h;
  if (reason) adminMsg += "\n⏰ Ранний уход. Причина: " + reason;
  notifyAdmin(adminMsg);
  send(chatId, "🔴 Смена закрыта: " + now() + h +
    (reason ? "\n⏰ Причина раннего ухода записана." : "") +
    "\n\nДоступ к рабочим функциям закрыт до следующего прихода.", backMenu());
}
function shiftBreak(chatId, user) {
  shiftLog(user.name, "перерыв", "", "");
  clearWaiting(chatId);
  showMainMenu(chatId, user);
}
function shiftBack(chatId, user) {
  shiftLog(user.name, "возврат", "", "");
  showMainMenu(chatId, user);
}


// ═══════════════════ ПРИЁМЩИК: КЛИЕНТЫ ═══════════════════
function showClient(chatId, user) {
  if (!isReception(user)) { send(chatId, "Раздел для приёмщика.", backMenu()); return; }
  const since = receptionBusySince(user.name);
  let txt = "🙋 ПРИЁМ КЛИЕНТА — " + user.name + "\n";
  const kb = [];
  if (since) {
    txt += "\nСейчас занят с клиентом с " + since + ".";
    kb.push([{ text: "✅ Освободился", callback_data: "client_free" }]);
  } else {
    txt += "\nСвободен. Жми когда начнёшь принимать клиента.";
    kb.push([{ text: "🙋 Принять клиента", callback_data: "client_take" }]);
  }
  kb.push([{ text: "⬅️ В меню", callback_data: "menu" }]);
  send(chatId, txt, { inline_keyboard: kb });
}
function clientTake(chatId, user) {
  if (receptionBusySince(user.name)) { send(chatId, "Ты уже принимаешь клиента."); showClient(chatId, user); return; }
  clientLog(user.name, "принял", "");
  SpreadsheetApp.flush();
  notifyAdmin("🙋 " + user.name + " принял клиента\n🕐 " + now());
  send(chatId, "🙋 Начат приём клиента: " + now() + "\nКак закончишь — жми «Освободился».", {
    inline_keyboard: [[{ text: "✅ Освободился", callback_data: "client_free" }], [{ text: "⬅️ В меню", callback_data: "menu" }]] });
}
function clientFree(chatId, user) {
  const since = receptionBusySince(user.name);
  if (!since) { send(chatId, "Ты сейчас не с клиентом."); showClient(chatId, user); return; }
  const mins = minutesBetween(since, now());
  clientLog(user.name, "освободился", mins);
  SpreadsheetApp.flush();
  notifyAdmin("✅ " + user.name + " освободился (клиент ≈ " + fmtDur(mins) + ")\n🕐 " + now());
  send(chatId, "✅ Приём завершён. Длительность ≈ " + fmtDur(mins) + ".", backMenu());
}


// ═══════════════════ ПОДРЯДЧИК ═══════════════════
function contractorRequest(chatId, user) {
  notifyAdmin("🔧 ПОДРЯДЧИК «" + user.name + "» просит машину в работу.\nВыбери машину и назначь ставку:", {
    inline_keyboard: [[{ text: "📋 Показать машины для " + user.name, callback_data: "appr:" + encodeURIComponent(user.name) }]] });
  send(chatId, "✅ Запрос отправлен руководителю. Жди — он откроет тебе машину со ставкой.", backMenu());
}
function approveList(chatId, user, encName) {
  if (!isAdmin(user)) return;
  const name = decodeURIComponent(encName);
  const cars = autoRows().filter(function (r) { return String(r[A.STATUS-1]).trim() === "в очереди"; });
  if (!cars.length) { send(chatId, "🚗 Сейчас нет машин в очереди для " + name + ".", backMenu()); return; }
  const kb = cars.map(function (r) {
    return [{ text: (r[A.MODEL-1] || "?") + " — " + (r[A.PLATE-1] || "?"),
             callback_data: "appr_car:" + r[A.ID-1] + ":" + encName }]; });
  kb.push([{ text: "⬅️ В меню", callback_data: "menu" }]);
  send(chatId, "Выбери машину для подрядчика " + name + ":", { inline_keyboard: kb });
}
function approveRateAsk(chatId, user, carId, encName) {
  if (!isAdmin(user)) return;
  const name = decodeURIComponent(encName);
  PropertiesService.getScriptProperties().setProperty("await_grant_" + chatId, carId + "|" + name);
  const car = findCar(carId);
  send(chatId, "Машина " + (car ? (car[A.MODEL-1] || carId) : carId) + " для " + name +
    ".\nВведи ставку за работу (число, zł):");
}
function grantConfirm(chatId, user, carId, contractorName, rate) {
  grantOpen(carId, contractorName, rate);
  SpreadsheetApp.flush();
  const car = findCar(carId);
  const label = car ? (car[A.MODEL-1] || carId) + " — " + (car[A.PLATE-1] || "") : carId;
  send(chatId, "✅ Машина " + label + " открыта для " + contractorName + ". Ставка: " + rate + " zł.", backMenu());
  const c = findStaffByName(contractorName);
  if (c && c.telegram) {
    notify(c.telegram, "🔧 Тебе открыли машину: " + label + "\n💰 Ставка за всю машину: " + rate +
      " zł (получишь, когда машину отдадут клиенту).");
    pushGrantCarScreen(c.telegram, contractorName, carId);
  }
}
function pushGrantCarScreen(contractorChatId, contractorName, carId) {
  const g = grantFor(carId, contractorName);
  const car = findCar(carId);
  if (!car) return;
  const stages = availableStages(car);
  const kb = stages.map(function (st) { return [{ text: "▶️ " + stageDisplay(st), callback_data: "g_stage:" + carId + ":" + stageCode(st) }]; });
  kb.push([{ text: "⬅️ В меню", callback_data: "menu" }]);
  const rate = g ? g.rate : "?";
  send(contractorChatId, "🚗 ТВОЯ МАШИНА: " + (car[A.MODEL-1] || carId) + " — " + (car[A.PLATE-1] || "") +
    "\n💰 Ставка за машину: " + rate + " zł\n\nВыбери этап и работай. Деньги — после выдачи клиенту.",
    stages.length ? { inline_keyboard: kb } : backMenu());
}
function showGrants(chatId, user) {
  const grants = openGrantsFor(user.name);
  if (!grants.length) { send(chatId, "🔧 Открытых машин нет. Нажми «Запросить машину».", backMenu()); return; }
  const kb = grants.map(function (g) {
    const car = findCar(g.carId);
    const label = car ? (car[A.MODEL-1] || g.carId) + " — " + (car[A.PLATE-1] || "") : g.carId;
    return [{ text: "🔧 " + label + " (" + g.rate + " zł)", callback_data: "g_take:" + g.carId }]; });
  kb.push([{ text: "⬅️ В меню", callback_data: "menu" }]);
  send(chatId, "🔧 Твои открытые машины:", { inline_keyboard: kb });
}
function grantChooseStage(chatId, user, carId) {
  const g = grantFor(carId, user.name);
  if (!g) { send(chatId, "Эта машина тебе не открыта.", backMenu()); return; }
  const car = findCar(carId);
  if (!car) { send(chatId, "Машина не найдена.", backMenu()); return; }
  const stages = availableStages(car);
  if (!stages.length) { send(chatId, "Все этапы сделаны.", backMenu()); return; }
  const kb = stages.map(function (st) { return [{ text: "▶️ " + stageDisplay(st), callback_data: "g_start:" + carId + ":" + stageCode(st) }]; });
  kb.push([{ text: "⬅️ Назад", callback_data: "my_grants" }]);
  send(chatId, "🚗 " + (car[A.MODEL-1] || carId) + " (ставка " + g.rate + " zł)\nКакой этап делаешь? (жми — сразу старт)", { inline_keyboard: kb });
}
// Совместимость со старыми сообщениями: сразу старт.
function grantChoosePlan(chatId, user, carId, stageCodeStr) {
  grantStartStage(chatId, user, carId, stageCodeStr, null);
}
function grantStartStage(chatId, user, carId, stageCodeStr, timeCodeStr) {
  const g = grantFor(carId, user.name);
  if (!g) { send(chatId, "Машина тебе не открыта.", backMenu()); return; }
  const stage = stageName(stageCodeStr);
  const plan = (timeCodeStr === null || timeCodeStr === undefined || timeCodeStr === "")
    ? "—" : timeName(timeCodeStr);
  const car = findCar(carId);
  if (!car) { send(chatId, "Машина не найдена.", backMenu()); return; }
  // Первый этап по машине — требуем фото ДО (как у мастеров).
  if (doneStages(carId).length === 0 && photoCount(carId, "до") < MIN_PHOTOS) {
    photoAsk(chatId, user, carId, "до");
    return;
  }
  const row = car._row;
  setCell(row, A.STATUS, "в работе"); setCell(row, A.STAGE, stage);
  setCell(row, A.WORKER, user.name); setCell(row, A.START, now()); setCell(row, A.PLAN, plan);
  setCell(row, A.TYPE, "подряд");
  SpreadsheetApp.flush();
  sendStageScreen(chatId, user, carId, "▶️ СТАРТ (подряд)");
}
function grantFinishStage(chatId, user, carId) {
  const g = grantFor(carId, user.name);
  const car = findCar(carId);
  if (!car) { send(chatId, "Машина не найдена.", backMenu()); return; }
  if (String(car[A.WORKER-1]).trim() !== user.name) { send(chatId, "⚠️ Это не твой этап.", backMenu()); return; }
  const stage = String(car[A.STAGE-1]).trim(), startStr = String(car[A.START-1]).trim(), plan = String(car[A.PLAN-1]).trim();
  // Защита от двойного закрытия этапа подрядчиком.
  if (doneStages(carId).indexOf(stage) !== -1) {
    const row0 = car._row;
    setCell(row0, A.WORKER, ""); setCell(row0, A.STAGE, ""); setCell(row0, A.START, ""); setCell(row0, A.PLAN, "");
    send(chatId, "⚠️ Этот этап уже закрыт по этой машине.", backMenu());
    return;
  }
  const factMin = startStr ? minutesBetween(startStr, now()) : "";
  sheet("Логи").appendRow([now(), carId, car[A.PLATE-1], user.name, stage, plan, startStr, now(), factMin, 0, "подряд: этап (оплата при выдаче)"]);
  const row = car._row;
  setCell(row, A.WORKER, ""); setCell(row, A.STAGE, ""); setCell(row, A.START, ""); setCell(row, A.PLAN, "");
  const ready = serviceAllDone(carId, stage);
  setCell(row, A.STATUS, ready ? "готова к выдаче" : "в очереди");
  SpreadsheetApp.flush();
  notifyAdmin("🔧 Подрядчик " + user.name + " закрыл «" + stageDisplay(stage) + "» по " + (car[A.MODEL-1] || carId) +
    " · ⏱ " + factMin + " мин" + (ready ? " · машина ГОТОВА" : ""));
  if (ready) {
    send(chatId, "✅ Этап «" + stageDisplay(stage) + "» закрыт.\n🏁 Машина готова к выдаче.\n" +
      "💰 Ставка " + (g ? g.rate : "?") + " zł будет начислена, когда машину отдадут клиенту.", backMenu());
    return;
  }
  const fresh = findCar(carId);
  const nextStages = availableStages(fresh);
  let txt = "✅ Этап «" + stage + "» закрыт.\n\n" + stagesOverview(carId);
  const kb = [];
  if (nextStages.length) {
    txt += "\n\n➡️ Дальше по этой машине:";
    nextStages.forEach(function (st) {
      kb.push([{ text: "▶️ " + st, callback_data: "g_stage:" + carId + ":" + stageCode(st) }]);
    });
  }
  kb.push([{ text: "⬅️ В меню", callback_data: "menu" }]);
  send(chatId, txt, { inline_keyboard: kb });
}


// ═══════════════════ ВЫДАЧА С ОПЛАТОЙ ═══════════════════
function issueCarAsk(chatId, user, carId) {
  if (!(isReception(user) || isAdmin(user))) { send(chatId, "Нет прав на выдачу.", backMenu()); return; }
  const car = findCar(carId);
  if (!car) { send(chatId, "Машина не найдена.", backMenu()); return; }
  const sum = car[A.PRICE-1] || "?";
  send(chatId, "🏁 Выдача: " + (car[A.MODEL-1] || carId) + " — " + (car[A.PLATE-1] || "") + "\n💵 По протоколу: " + sum +
    " zł\n\nЧем платит клиент?", {
    inline_keyboard: [
      [{ text: "💵 Наличные (по протоколу)", callback_data: "pay_cash:" + carId }],
      [{ text: "💳 Карта (по протоколу)", callback_data: "pay_card:" + carId }],
      [{ text: "➕ Доплата сверх протокола", callback_data: "pay_extra:" + carId }],
      [{ text: "✏️ Другая сумма / разбить", callback_data: "pay_man:" + carId }],
      [{ text: "⬅️ Отмена", callback_data: "ready" }]] });
}
function issuePayCash(chatId, user, carId) {
  const car = findCar(carId);
  if (!car) { send(chatId, "Машина не найдена.", backMenu()); return; }
  if (String(car[A.STATUS-1]).trim() === "выдана") { send(chatId, "⚠️ Эта машина уже выдана.", backMenu()); return; }
  const sum = Number(car[A.PRICE-1]) || 0;
  cashAdd("приход", sum, user.name, carId, "выдача " + (car[A.PLATE-1] || ""));
  setCell(car._row, A.STATUS, "выдана");
  payContractorOnIssue(carId);
  SpreadsheetApp.flush();
  send(chatId, "✅ " + (car[A.MODEL-1] || carId) + " выдана.\n💵 В кассу (нал): +" + sum +
    " zł\nОстаток в кассе: " + cashBalance() + " zł", backMenu());
}
function issuePayCard(chatId, user, carId) {
  const car = findCar(carId);
  if (!car) { send(chatId, "Машина не найдена.", backMenu()); return; }
  if (String(car[A.STATUS-1]).trim() === "выдана") { send(chatId, "⚠️ Эта машина уже выдана.", backMenu()); return; }
  const sum = Number(car[A.PRICE-1]) || 0;
  cardAdd(sum, user.name, carId, "выдача " + (car[A.PLATE-1] || ""));
  companyAdd("приход", sum, "карта", user.name, "выдача " + carId);
  setCell(car._row, A.STATUS, "выдана");
  payContractorOnIssue(carId);
  SpreadsheetApp.flush();
  if (isAdmin(user))
    send(chatId, "✅ " + (car[A.MODEL-1] || carId) + " выдана.\n💳 Картой: +" + sum + " zł → счёт фирмы.", backMenu());
  else
    send(chatId, "✅ " + (car[A.MODEL-1] || carId) + " выдана. Оплата картой принята.", backMenu());
}
function issuePayManual(chatId, user, carId) {
  PropertiesService.getScriptProperties().setProperty("await_issue_" + chatId, carId);
  send(chatId, "Введи сумму и способ (можно с примечанием через «;»):\n" +
    "• 500 нал\n• 500 карта\n• 300 нал + 200 карта\n• 800 нал ; керамика фар + полировка порогов");
}
function issuePayExtra(chatId, user, carId) {
  if (!(isReception(user) || isAdmin(user))) { send(chatId, "Нет прав на выдачу.", backMenu()); return; }
  const car = findCar(carId);
  if (!car) { send(chatId, "Машина не найдена.", backMenu()); return; }
  PropertiesService.getScriptProperties().setProperty("await_extra_" + chatId, carId);
  const sum = Number(car[A.PRICE-1]) || 0;
  send(chatId, "➕ ДОПЛАТА сверх протокола.\nПо протоколу: " + sum + " zł.\n\n" +
    "Введи ИТОГОВУЮ сумму, способ и что доделали (через «;»):\n" +
    "• 900 нал ; химчистка салона\n" +
    "• 600 нал + 400 карта ; керамика дисков\n\n" +
    "Разницу с протоколом запишу как доп. услугу.");
}


// ═══════════════════ ИНКАССАЦИЯ ═══════════════════
function collectAsk(chatId, user) {
  if (!isAdmin(user)) { send(chatId, "Только для руководителя.", backMenu()); return; }
  const bal = cashBalance();
  send(chatId, "🧰 ИНКАССАЦИЯ\n\nВ кассе сейчас: " + bal + " zł\n\nПересчитай ящик и забери.", {
    inline_keyboard: [[{ text: "✅ Забрать всё (" + bal + " zł)", callback_data: "collect_all" }],
                      [{ text: "✏️ Ввести фактическую", callback_data: "collect_man" }],
                      [{ text: "⬅️ В меню", callback_data: "menu" }]] });
}
function collectAll(chatId, user) {
  if (!isAdmin(user)) return;
  const bal = cashBalance();
  if (bal <= 0) { send(chatId, "В кассе пусто.", backMenu()); return; }
  cashAdd("инкассация", bal, user.name, "", "забрал всё");
  companyAdd("приход", bal, "инкассация нал", user.name, "");
  SpreadsheetApp.flush();
  send(chatId, "🧰 Забрано: " + bal + " zł → счёт фирмы.\nКасса обнулена.\nБаланс фирмы: " + companyBalance() + " zł", backMenu());
}
function collectManual(chatId, user) {
  if (!isAdmin(user)) return;
  PropertiesService.getScriptProperties().setProperty("await_collect_" + chatId, "1");
  send(chatId, "В кассе по расчёту: " + cashBalance() + " zł.\nВведи СКОЛЬКО ФАКТИЧЕСКИ забрал (число):", backMenu());
}


// ═══════════════════ КАССА (экран) ═══════════════════
function showCash(chatId, user) {
  if (!(isReception(user) || isAdmin(user))) { send(chatId, "Нет доступа к кассе.", backMenu()); return; }
  const bal = cashBalance();
  const sh = getCashSheet();
  let txt = "💵 КАССА ДЕТЕЙЛИНГА (нал)\n\nСейчас в кассе: " + bal + " zł\n";
  if (sh.getLastRow() > 1) {
    const take = Math.min(8, sh.getLastRow() - 1);
    const rows = sh.getRange(sh.getLastRow() - take + 1, 1, take, 6).getValues();
    txt += "\n── последние операции ──";
    rows.reverse().forEach(function (r) {
      const sign = String(r[1]).trim() === "приход" ? "+" : "−";
      txt += "\n" + r[0] + "  " + sign + r[2] + " zł  " + (r[5] || r[1]); });
  } else txt += "\n(операций нет)";
  const kb = [[{ text: "➕ Принять нал вручную", callback_data: "cash_add" }]];
  if (isAdmin(user)) kb.push([{ text: "🧰 Инкассация (забрать)", callback_data: "collect" }]);
  kb.push([{ text: "⬅️ В меню", callback_data: "menu" }]);
  send(chatId, txt, { inline_keyboard: kb });
}
function cashAddAsk(chatId, user) {
  if (!(isReception(user) || isAdmin(user))) { send(chatId, "Нет доступа.", backMenu()); return; }
  PropertiesService.getScriptProperties().setProperty("await_cash_" + chatId, "1");
  send(chatId, "Введи сумму нала (число), можно с комментарием:\nнапр. «300 предоплата BMW»", backMenu());
}
function cardAddAsk(chatId, user) {
  if (!(isReception(user) || isAdmin(user))) { send(chatId, "Нет доступа.", backMenu()); return; }
  PropertiesService.getScriptProperties().setProperty("await_card_" + chatId, "1");
  send(chatId, "Платёж картой. Введи сумму (число), можно с комментарием:", backMenu());
}


// ═══════════════════ ФИРМЕННЫЙ СЧЁТ ═══════════════════
function showCompany(chatId, user) {
  if (!isAdmin(user)) { send(chatId, "Только для руководителя.", backMenu()); return; }
  const bal = companyBalance();
  const sh = getCompanySheet();
  let txt = "🏦 ФИРМЕННЫЙ СЧЁТ\n\nБаланс: " + bal + " zł\n";
  if (sh.getLastRow() > 1) {
    const take = Math.min(10, sh.getLastRow() - 1);
    const rows = sh.getRange(sh.getLastRow() - take + 1, 1, take, 6).getValues();
    txt += "\n── последние движения ──";
    rows.reverse().forEach(function (r) {
      const sign = String(r[1]).trim() === "приход" ? "+" : "−";
      txt += "\n" + r[0] + "  " + sign + r[2] + " zł  " + (r[3] || "") + (r[5] ? " — " + r[5] : ""); });
  } else txt += "\n(движений нет)";
  send(chatId, txt, { inline_keyboard: [
    [{ text: "➖ Записать расход", callback_data: "exp_add" }],
    [{ text: "➕ Записать приход", callback_data: "inc_add" }],
    [{ text: "🧰 Инкассация кассы", callback_data: "collect" }],
    [{ text: "⬅️ В меню", callback_data: "menu" }]] });
}
function expenseAsk(chatId, user) {
  if (!isAdmin(user)) return;
  PropertiesService.getScriptProperties().setProperty("await_expense_" + chatId, "1");
  send(chatId, "Расход: сумма + на что.\nнапр. «450 химия» или «1200 аренда»", backMenu());
}
function incomeAsk(chatId, user) {
  if (!isAdmin(user)) return;
  PropertiesService.getScriptProperties().setProperty("await_income_" + chatId, "1");
  send(chatId, "Приход на счёт: сумма + источник.\nнапр. «2000 пополнение»", backMenu());
}


// ═══════════════════ ЗАРПЛАТА (сотрудник) ═══════════════════
function showMySalary(chatId, user) {
  const period = payPeriod();
  const accrued = accruedFor(user.name, period);
  const paid = paidOutFor(user.name, period);
  const left = Math.round((accrued - paid) * 100) / 100;
  const items = salaryBreakdown(user.name, period);
  const full = PropertiesService.getScriptProperties().getProperty("salfull_" + chatId) === "1";
  PropertiesService.getScriptProperties().deleteProperty("salfull_" + chatId);

  let txt = "💰 МОИ ДЕНЬГИ — период " + periodLabel(period) + "\n";
  txt += "\nНачислено: " + accrued + " zł";
  txt += "\nВыдано: " + paid + " zł";
  if (left >= 0) txt += "\nК выдаче: " + left + " zł";
  else txt += "\nВыдан аванс: " + (-left) + " zł (вперёд)";

  const kb = [];
  if (items.length) {
    const list = items.slice().reverse(); // последнее сверху, как выписка
    const show = full ? list : list.slice(0, 8);
    txt += "\n\nПоследнее:";
    show.forEach(function (it) {
      txt += "\n- " + it.plate + " · " + it.stage + " · " + it.pay + " zł · " + it.when;
    });
    if (!full && list.length > 8) {
      txt += "\n…ещё " + (list.length - 8);
      kb.push([{ text: "📄 Весь список", callback_data: "mysalary_full" }]);
    }
  } else txt += "\n\n(начислений за период нет)";

  const startSal = startSalaryFor(user.name);
  if (startSal > 0 && period.from.getTime() === payPeriod().from.getTime())
    txt += "\n• стартовая ЗП (до бота): " + startSal + " zł";
  kb.push([{ text: "⬅️ В меню", callback_data: "menu" }]);
  send(chatId, txt, { inline_keyboard: kb });
}


// ═══════════════════ ЗАРПЛАТЫ (админ) + ВЫПЛАТЫ ═══════════════════
function allWorkerNames() {
  const staff = getStaff().map(function (r) { return String(r[1]).trim(); }).filter(Boolean);
  sheetValues("Логи", 11).forEach(function (r) {
    const n = String(r[3]).trim(); if (n && staff.indexOf(n) === -1) staff.push(n);
  });
  return staff;
}
function showPayroll(chatId, user) {
  if (!isAdmin(user)) { send(chatId, "Только для руководителя.", backMenu()); return; }
  const period = payPeriod();
  let txt = "🧾 ЗАРПЛАТЫ — период " + periodLabel(period) + "\n";
  const kb = []; let anyShown = false;
  allWorkerNames().forEach(function (name) {
    const accrued = accruedFor(name, period), paid = paidOutFor(name, period);
    const left = Math.round((accrued - paid) * 100) / 100;
    if (accrued === 0 && paid === 0) return;
    anyShown = true;
    let tail;
    if (left > 0)      tail = "к выпл. " + left + " zł";
    else if (left < 0) tail = "⚠️ выдан аванс " + (-left) + " zł";
    else               tail = "выплачено ✅";
    txt += "\n👤 " + name + ": нач. " + accrued + ", выпл. " + paid + " → " + tail;
    const row = [];
    if (left > 0) row.push({ text: "💸 Всё " + left, callback_data: "payall:" + encodeURIComponent(name) });
    row.push({ text: "✏️ Выдать сумму", callback_data: "paypart:" + encodeURIComponent(name) });
    kb.push(row);
  });
  if (!anyShown) txt += "\n\nНачислений пока нет.";
  kb.push([{ text: "🔄 Обновить", callback_data: "payroll" }]);
  kb.push([{ text: "⬅️ В меню", callback_data: "menu" }]);
  send(chatId, txt, { inline_keyboard: kb });
}
function payAll(chatId, user, encName) {
  if (!isAdmin(user)) return;
  const name = decodeURIComponent(encName);
  const period = payPeriod();
  const left = Math.round((accruedFor(name, period) - paidOutFor(name, period)) * 100) / 100;
  if (left <= 0) { notify(chatId, "У " + name + " нечего выдавать."); showPayroll(chatId, user); return; }
  payoutAdd(name, left, user.name);
  companyAdd("расход", left, "зарплата " + name, user.name, "выплата ЗП полностью");  // ← списываем с фирмы
  notify(chatId, "💸 Выдано " + name + ": " + left + " zł. Остаток 0.\n🏦 Со счёта фирмы. Баланс: " + companyBalance() + " zł");
  showPayroll(chatId, user);
}
function payPartAsk(chatId, user, encName) {
  if (!isAdmin(user)) return;
  const name = decodeURIComponent(encName);
  PropertiesService.getScriptProperties().setProperty("await_paypart_" + chatId, name);
  const period = payPeriod();
  const left = Math.round((accruedFor(name, period) - paidOutFor(name, period)) * 100) / 100;
  let info;
  if (left > 0) info = "К выплате сейчас: " + left + " zł.";
  else if (left < 0) info = "Уже выдан аванс: " + (-left) + " zł.";
  else info = "Всё выплачено.";
  send(chatId, "Выплата для " + name + ".\n" + info +
    "\n\nВведи сумму (число). Можно БОЛЬШЕ — тогда уйдёт в аванс (овердрафт):");
}


// ═══════════════════ СВОДКИ ═══════════════════
function showSummary(chatId, user) {
  if (!isAdmin(user)) { send(chatId, "Только для руководителя.", backMenu()); return; }
  const period = payPeriod();
  const cashIn = cashInTotal(period), card = cardTotal(period);
  const revenue = Math.round((cashIn + card) * 100) / 100;
  const incomes = companySumByType("приход", period), expense = companySumByType("расход", period);
  let payrollTotal = 0;
  allWorkerNames().forEach(function (n) { payrollTotal += accruedFor(n, period); });
  payrollTotal = Math.round(payrollTotal * 100) / 100;
  const profit = Math.round((revenue - expense - payrollTotal) * 100) / 100;
  let txt = "📊 СВОДКА — период " + periodLabel(period) + "\n";
  txt += "\n💵 Нал принято: " + cashIn + " zł";
  txt += "\n💳 Карта принято: " + card + " zł";
  txt += "\n━━ Выручка: " + revenue + " zł\n";
  txt += "\n🏦 Приходы на счёт: " + incomes + " zł";
  txt += "\n➖ Расходы: " + expense + " zł";
  txt += "\n💰 ЗП начислено: " + payrollTotal + " zł";
  txt += "\n━━ Грубо в плюсе: " + profit + " zł";
  txt += "\n\n📦 В кассе нал: " + cashBalance() + " zł";
  txt += "\n🏦 Баланс фирмы: " + companyBalance() + " zł";
  send(chatId, txt, { inline_keyboard: [
    [{ text: "👥 Часы по сменам", callback_data: "sum_hours" }],
    [{ text: "🔄 Обновить", callback_data: "summary" }],
    [{ text: "⬅️ В меню", callback_data: "menu" }]] });
}

// ═══════════ ПОДРОБНАЯ СТАТИСТИКА ЗА ДЕНЬ (для админа и отчёта в 23:00) ═══════════
// По каждому мастеру: смена (мин), пауза (мин), чистая работа, список этапов, заработок.
function dayStatsText(from, to) {
  // 1) Смены: суммируем минуты завершённых смен (событие "ушёл").
  const shiftMin = {};
  {
    const sh = getShiftSheet();
    if (sh.getLastRow() > 1)
      sh.getRange(2,1,sh.getLastRow()-1,6).getValues().forEach(function (r) {
        if (String(r[2]).trim() !== "ушёл") return;
        const dt = parseDt(r[0]);
        if (!dt || dt < from || dt >= to) return;
        const n = String(r[1]).trim();
        shiftMin[n] = (shiftMin[n] || 0) + (Number(r[4]) || 0);
      });
  }
  // 2) Логи: по каждому мастеру — этапы, факт-минуты, пауза, заработок.
  const work = {}; // name -> { stages:[], factMin, pauseMin, pay }
  function ensure(n){ if(!work[n]) work[n]={stages:[],factMin:0,pauseMin:0,pay:0}; return work[n]; }
  {
    const sh = sheet("Логи");
    if (sh.getLastRow() > 1)
      sh.getRange(2,1,sh.getLastRow()-1,11).getValues().forEach(function (r) {
        const dt = parseDt(r[0]);
        if (!dt || dt < from || dt >= to) return;
        const name = String(r[3]).trim();
        if (!name) return;
        const stage = String(r[4]).trim();
        const fact = Number(r[8]) || 0;
        const pay = Number(r[9]) || 0;
        const comment = String(r[10] || "");
        const w = ensure(name);
        if (stage) w.stages.push(stage);
        w.factMin += fact;
        w.pay += pay;
        const pm = comment.match(/пауза\s*(\d+)\s*мин/);
        if (pm) w.pauseMin += Number(pm[1]) || 0;
      });
  }
  // 3) Собираем текст.
  const names = {};
  Object.keys(shiftMin).forEach(function(n){ names[n]=1; });
  Object.keys(work).forEach(function(n){ names[n]=1; });
  const list = Object.keys(names);
  if (!list.length) return "\n\n👥 Никто сегодня не работал.";
  let txt = "\n\n👥 ПО ЛЮДЯМ:";
  list.forEach(function (n) {
    const sm = shiftMin[n] || 0;
    const w = work[n] || {stages:[],factMin:0,pauseMin:0,pay:0};
    const clean = w.factMin;
    const idle = Math.max(0, sm - w.factMin - w.pauseMin);
    // сколько раз какой этап
    const cnt = {};
    w.stages.forEach(function(s){ cnt[s]=(cnt[s]||0)+1; });
    const stagesStr = Object.keys(cnt).length
      ? Object.keys(cnt).map(function(s){ return s + (cnt[s]>1?" ×"+cnt[s]:""); }).join(", ")
      : "—";
    txt += "\n\n👤 " + n;
    txt += "\n   🕒 Смена: " + fmtDur(sm);
    if (w.pauseMin > 0) txt += " · ⏸ Пауза: " + fmtDur(w.pauseMin);
    txt += "\n   ⚡ Чистая работа: " + fmtDur(clean);
    if (idle > 5) txt += "\n   💤 Простой (на смене без дела): " + fmtDur(idle);
    txt += "\n   🔧 Делал: " + stagesStr;
    if (w.pay > 0) txt += "\n   💰 Заработал: " + (Math.round(w.pay*100)/100) + " zł";
  });
  return txt;
}

// Экран «Статистика за день» для админа (сегодня, с кнопкой «вчера»).
function showDayStats(chatId, user, offsetDays) {
  if (!isAdmin(user)) { send(chatId, "Только для руководителя.", backMenu()); return; }
  const off = Number(offsetDays) || 0;
  const base = new Date();
  base.setDate(base.getDate() - off);
  const from = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0,0,0);
  const to   = new Date(base.getFullYear(), base.getMonth(), base.getDate()+1, 0,0,0);
  const label = Utilities.formatDate(from, Session.getScriptTimeZone(), "dd.MM.yyyy");
  const cashIn = cashInTotal({from:from,to:to});
  const card   = cardTotal({from:from,to:to});
  let txt = "📅 СТАТИСТИКА ЗА " + label + (off===0?" (сегодня)":off===1?" (вчера)":"");
  txt += "\n💵 Нал: " + cashIn + " zł · 💳 Карта: " + card + " zł";
  txt += dayStatsText(from, to);
  send(chatId, txt, { inline_keyboard: [
    [{ text: "◀️ День назад", callback_data: "daystats:" + (off+1) },
     { text: off>0 ? "День вперёд ▶️" : " ", callback_data: off>0 ? "daystats:" + (off-1) : "noop" }],
    [{ text: "⬅️ В меню", callback_data: "menu" }] ] });
}

function showHoursSummary(chatId, user) {
  if (!isAdmin(user)) { send(chatId, "Только для руководителя.", backMenu()); return; }
  const period = payPeriod();
  const sh = getShiftSheet();
  const totals = {};
  if (sh.getLastRow() > 1)
    sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues().forEach(function (r) {
      if (String(r[2]).trim() !== "ушёл") return;
      const dt = parseDt(r[0]);
      if (!dt || dt < period.from || dt >= period.to) return;
      const name = String(r[1]).trim();
      totals[name] = (totals[name] || 0) + (Number(r[4]) || 0); });
  let txt = "👥 ЧАСЫ — период " + periodLabel(period) + "\n";
  const names = Object.keys(totals);
  if (!names.length) txt += "\n(закрытых смен нет)";
  else names.forEach(function (n) { txt += "\n👤 " + n + ": " + fmtDur(totals[n]); });
  txt += "\n\n(считаются завершённые смены)";
  send(chatId, txt, { inline_keyboard: [
    [{ text: "⬅️ К сводке", callback_data: "summary" }],
    [{ text: "⬅️ В меню", callback_data: "menu" }]] });
}


// ═══════════════════ ПЕРСОНАЛ / ДОСТУП (админ) ═══════════════════
function showStaff(chatId, user) {
  if (!isAdmin(user)) { send(chatId, "Только для руководителя.", backMenu()); return; }
  const d = getStaff();
  let txt = "👷 ПЕРСОНАЛ\n(чтобы добавить/убрать человека — правь лист «Персонал»)\n";
  const kb = [];
  for (let i = 0; i < d.length; i++) {
    const u = rowToUser(d[i], i);
    if (!u.name) continue;
    const stat = u.active ? "🟢" : "⛔";
    const onShift = isOnShift(u.name) ? " · на смене" : "";
    txt += "\n" + stat + " " + u.name + " (" + u.role + ")" + onShift;
    if (u.role === "админ") continue;
    if (u.active) kb.push([{ text: "⛔ Заблокировать " + u.name, callback_data: "staff_ban:" + u.row }]);
    else kb.push([{ text: "✅ Разблокировать " + u.name, callback_data: "staff_unban:" + u.row }]);
  }
  kb.push([{ text: "🔄 Обновить", callback_data: "staff" }]);
  kb.push([{ text: "⬅️ В меню", callback_data: "menu" }]);
  send(chatId, txt, { inline_keyboard: kb });
}
function staffBan(chatId, user, rowStr) {
  if (!isAdmin(user)) return;
  const row = Number(rowStr);
  sheet("Персонал").getRange(row, 6).setValue("нет");
  SpreadsheetApp.flush();
  notify(chatId, "⛔ Заблокирован. Доступ к боту закрыт."); showStaff(chatId, user);
}
function staffUnban(chatId, user, rowStr) {
  if (!isAdmin(user)) return;
  const row = Number(rowStr);
  sheet("Персонал").getRange(row, 6).setValue("да");
  SpreadsheetApp.flush();
  notify(chatId, "✅ Разблокирован."); showStaff(chatId, user);
}


// ═══════════════════ АДМИН-ПАНЕЛЬ ═══════════════════
function showAdmin(chatId) {
  const active = autoRows().filter(function (r) { return String(r[A.STATUS-1]).trim() === "в работе"; });
  let txt = "⚙️ АДМИН-ПАНЕЛЬ\n\nМашин в работе: " + active.length + "\n";
  const kb = [];
  active.forEach(function (r) {
    txt += "\n🚗 " + (r[A.MODEL-1] || r[A.ID-1]) + " — " + r[A.STAGE-1] + " (" + r[A.WORKER-1] + ", с " + r[A.START-1] + ")";
    kb.push([{ text: "🔧 Сброс: " + (r[A.PLATE-1] || r[A.ID-1]), callback_data: "areset:" + r[A.ID-1] },
             { text: "🗑", callback_data: "del:" + r[A.ID-1] }]);
  });
  const queue = autoRows().filter(function (r) { return String(r[A.STATUS-1]).trim() === "в очереди"; });
  if (queue.length) txt += "\n\nВ очереди: " + queue.length;
  queue.forEach(function (r) {
    kb.push([{ text: "➡️ Виталию: " + (r[A.PLATE-1] || r[A.ID-1]), callback_data: "contract:" + r[A.ID-1] },
             { text: "🗑", callback_data: "del:" + r[A.ID-1] }]);
  });
  kb.push([{ text: "↩️ Отмена операций (сторно)", callback_data: "undo_menu" }]);
  kb.push([{ text: "🔄 Обновить", callback_data: "admin" }]);
  kb.push([{ text: "⬇️ Синхронизировать с Google", callback_data: "gpull" }]);
  kb.push([{ text: "🧹 Сброс теста (вернуть всё)", callback_data: "testreset" }]);
  kb.push([{ text: "⬅️ В меню", callback_data: "menu" }]);
  send(chatId, txt, { inline_keyboard: kb });
}
function delAsk(chatId, user, carId) {
  if (!isAdmin(user)) return;
  const car = findCar(carId);
  if (!car) { send(chatId, "Машина не найдена.", backMenu()); return; }
  send(chatId, "🗑 Удалить " + (car[A.MODEL-1] || carId) + " — " + (car[A.PLATE-1] || "") +
    " ?\nНе вернётся при «Обновить». PDF останется.", {
    inline_keyboard: [[{ text: "🗑 Да, удалить", callback_data: "delyes:" + carId }], [{ text: "⬅️ Нет", callback_data: "admin" }]] });
}
function delDo(chatId, user, carId) {
  if (!isAdmin(user)) return;
  const car = findCar(carId);
  if (!car) { send(chatId, "Машина не найдена.", backMenu()); return; }
  blacklistAdd(carId, user.name);
  sheet("Авто").deleteRow(car._row); SpreadsheetApp.flush();
  send(chatId, "🗑 " + carId + " удалена и в брак.", backMenu());
}
function adminReset(chatId, user, carId) {
  if (!isAdmin(user)) return;
  const car = findCar(carId);
  if (!car) return;
  setCell(car._row, A.STATUS, "в очереди"); setCell(car._row, A.STAGE, "");
  setCell(car._row, A.WORKER, ""); setCell(car._row, A.START, ""); setCell(car._row, A.PLAN, "");
  SpreadsheetApp.flush();
  send(chatId, "🔧 " + (car[A.PLATE-1] || carId) + " сброшена в очередь.", backMenu());
}
function contractAsk(chatId, user, carId) {
  if (!isAdmin(user)) return;
  PropertiesService.getScriptProperties().setProperty("await_contract_" + chatId, carId);
  send(chatId, "Введи сумму для Виталия по машине " + carId + " (только число, zł):");
}


// ═══════════════════ ТЕКСТОВЫЙ ВВОД ═══════════════════
function handleTextInput(chatId, text, user) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty("await_photo_" + chatId)) {
    send(chatId, "📸 Сейчас нужно прислать ФОТО, а не текст. Пришли снимки или жми «В меню».", { inline_keyboard: [[{ text: "⬅️ В меню", callback_data: "menu" }]] });
    return true;
  }

  // ── причина пропуска пункта чек-листа
  if (handleChecklistSkip(chatId, text, user)) return true;

  // ── сумма помощи помощнику (v5)
  if (handleHelpInput(chatId, text, user)) return true;

  // ── причина ОПОЗДАНИЯ
  const lateMin = props.getProperty("await_late_" + chatId);
  if (lateMin) {
    props.deleteProperty("await_late_" + chatId);
    appendShiftComment(user.name, "опоздание ~" + lateMin + " мин: " + text);
    SpreadsheetApp.flush();
    notifyAdmin("⏰ " + user.name + " — причина опоздания (~" + lateMin + " мин):\n" + text);
    send(chatId, "✅ Причина записана. Хорошей смены!");
    showMainMenu(chatId, user);
    return true;
  }

  // ── причина РАННЕГО УХОДА
  const earlyMin = props.getProperty("await_early_" + chatId);
  if (earlyMin) {
    props.deleteProperty("await_early_" + chatId);
    doShiftOut(chatId, user, text);
    return true;
  }

  // ── ставка подрядчику
  const grantData = props.getProperty("await_grant_" + chatId);
  if (grantData && isAdmin(user)) {
    props.deleteProperty("await_grant_" + chatId);
    const sep = grantData.split("|");
    const carId = sep[0], contractorName = sep[1];
    const rate = parseAmount(text);
    if (!rate) { send(chatId, "Не понял ставку. Отменено.", backMenu()); return true; }
    grantConfirm(chatId, user, carId, contractorName, rate);
    return true;
  }

  // ── частичная выплата ЗП
  const partName = props.getProperty("await_paypart_" + chatId);
  if (partName && isAdmin(user)) {
    props.deleteProperty("await_paypart_" + chatId);
    const amount = parseAmount(text);
    if (!amount) { send(chatId, "Не понял сумму. Отменено.", backMenu()); return true; }
    const period = payPeriod();
    const left = Math.round((accruedFor(partName, period) - paidOutFor(partName, period)) * 100) / 100;
    payoutAdd(partName, amount, user.name);
    companyAdd("расход", amount, "зарплата " + partName, user.name, "выплата ЗП");  // ← списываем с фирмы
    SpreadsheetApp.flush();
    const newLeft = Math.round((left - amount) * 100) / 100;
    let msg = "💸 Выдано " + partName + ": " + amount + " zł.";
    if (newLeft < 0)      msg += "\n⚠️ Ушло в аванс. Долг работнику теперь: " + (-newLeft) + " zł (переплата вперёд).";
    else if (newLeft === 0) msg += "\nОстаток к выплате: 0.";
    else                  msg += "\nОстаток к выплате: " + newLeft + " zł.";
    msg += "\n🏦 Со счёта фирмы. Баланс: " + companyBalance() + " zł";
    send(chatId, msg, backMenu());
    return true;
  }

  // ── ручная выдача машины
  const issueCar = props.getProperty("await_issue_" + chatId);
  if (issueCar) {
    props.deleteProperty("await_issue_" + chatId);
    const car = findCar(issueCar);
    if (!car) { send(chatId, "Машина не найдена.", backMenu()); return true; }
    const p = parseSplitPayment(text);
    if (!p.ok) { send(chatId, "Не понял. Пример: «300 нал + 200 карта».", backMenu()); return true; }
    const plate = car[A.PLATE-1] || "";
    const baseNote = "выдача " + plate + (p.note ? " · " + p.note : "");
    if (p.cash > 0) cashAdd("приход", p.cash, user.name, issueCar, baseNote);
    if (p.card > 0) { cardAdd(p.card, user.name, issueCar, baseNote); companyAdd("приход", p.card, "карта", user.name, "выдача " + issueCar + (p.note ? " · " + p.note : "")); }
    setCell(car._row, A.STATUS, "выдана");
    payContractorOnIssue(issueCar);
    SpreadsheetApp.flush();
    let msg = "✅ " + (car[A.MODEL-1] || issueCar) + " выдана.";
    if (p.cash > 0) msg += "\n💵 Нал: +" + p.cash + " zł";
    if (p.card > 0) msg += "\n💳 Карта: +" + p.card + " zł";
    if (p.note) msg += "\n📝 " + p.note;
    if (isAdmin(user) && p.cash > 0) msg += "\nВ кассе: " + cashBalance() + " zł";
    send(chatId, msg, backMenu());
    return true;
  }

  // ── выдача с ДОПЛАТОЙ
  const extraCar = props.getProperty("await_extra_" + chatId);
  if (extraCar) {
    props.deleteProperty("await_extra_" + chatId);
    const car = findCar(extraCar);
    if (!car) { send(chatId, "Машина не найдена.", backMenu()); return true; }
    const p = parseSplitPayment(text);
    if (!p.ok) { send(chatId, "Не понял сумму. Пример: «900 нал ; химчистка».", backMenu()); return true; }
    const proto = Number(car[A.PRICE-1]) || 0;
    const total = Math.round((p.cash + p.card) * 100) / 100;
    const extra = Math.round((total - proto) * 100) / 100;
    const plate = car[A.PLATE-1] || "";
    const note = p.note || "доп. услуги";
    const tail = " · доплата " + (extra >= 0 ? "+" : "") + extra + " zł (" + note + ")";
    if (p.cash > 0) cashAdd("приход", p.cash, user.name, extraCar, "выдача " + plate + tail);
    if (p.card > 0) { cardAdd(p.card, user.name, extraCar, "выдача " + plate + tail); companyAdd("приход", p.card, "карта", user.name, "выдача " + extraCar + tail); }
    sheet("Логи").appendRow([now(), extraCar, plate, user.name, "Доп. услуга", "", "", now(), "", "", note + " (+" + extra + " zł)"]);
    setCell(car._row, A.STATUS, "выдана");
    payContractorOnIssue(extraCar);
    SpreadsheetApp.flush();
    let msg = "✅ " + (car[A.MODEL-1] || extraCar) + " выдана.\n💵 По протоколу: " + proto + " zł";
    msg += "\n💰 Итого получено: " + total + " zł";
    if (extra !== 0) msg += "\n➕ Доплата: " + (extra > 0 ? "+" : "") + extra + " zł";
    msg += "\n📝 " + note;
    if (p.cash > 0) msg += "\n💵 Нал: +" + p.cash + " zł";
    if (p.card > 0) msg += "\n💳 Карта: +" + p.card + " zł";
    if (isAdmin(user) && p.cash > 0) msg += "\nВ кассе: " + cashBalance() + " zł";
    send(chatId, msg, backMenu());
    return true;
  }

  // ── приём нала вручную
  if (props.getProperty("await_cash_" + chatId)) {
    props.deleteProperty("await_cash_" + chatId);
    const p = parseAmountNote(text);
    if (!p.amount) { send(chatId, "Не понял сумму. Отменено.", backMenu()); return true; }
    cashAdd("приход", p.amount, user.name, "", p.note || "ручной приём"); SpreadsheetApp.flush();
    send(chatId, "💵 Принято нал: +" + p.amount + " zł" + (p.note ? " (" + p.note + ")" : "") +
      "\nВ кассе: " + cashBalance() + " zł", backMenu());
    return true;
  }

  // ── приём картой вручную
  if (props.getProperty("await_card_" + chatId)) {
    props.deleteProperty("await_card_" + chatId);
    const p = parseAmountNote(text);
    if (!p.amount) { send(chatId, "Не понял сумму. Отменено.", backMenu()); return true; }
    cardAdd(p.amount, user.name, "", p.note || "ручной приём");
    companyAdd("приход", p.amount, "карта", user.name, p.note || ""); SpreadsheetApp.flush();
    send(chatId, "💳 Платёж картой принят" + (p.note ? " (" + p.note + ")" : "") + ". Спасибо.", backMenu());
    return true;
  }

  // ── инкассация фактической суммой
  if (props.getProperty("await_collect_" + chatId)) {
    props.deleteProperty("await_collect_" + chatId);
    const p = parseAmountNote(text);
    if (!p.amount) { send(chatId, "Не понял сумму. Отменено.", backMenu()); return true; }
    const expected = cashBalance();
    cashAdd("инкассация", p.amount, user.name, "", "факт (расчёт " + expected + ")");
    companyAdd("приход", p.amount, "инкассация нал", user.name, ""); SpreadsheetApp.flush();
    const diff = Math.round((p.amount - expected) * 100) / 100;
    let msg = "🧰 Забрано: " + p.amount + " zł → счёт фирмы.";
    if (diff !== 0) msg += "\n⚠️ Расхождение: " + (diff > 0 ? "+" : "") + diff + " zł";
    msg += "\nКасса: " + cashBalance() + " zł\nБаланс фирмы: " + companyBalance() + " zł";
    send(chatId, msg, backMenu());
    return true;
  }

  // ── расход фирмы
  if (props.getProperty("await_expense_" + chatId)) {
    props.deleteProperty("await_expense_" + chatId);
    const p = parseAmountNote(text);
    if (!p.amount) { send(chatId, "Не понял сумму. Отменено.", backMenu()); return true; }
    companyAdd("расход", p.amount, p.note || "прочее", user.name, ""); SpreadsheetApp.flush();
    send(chatId, "➖ Расход: " + p.amount + " zł — " + (p.note || "прочее") + "\nБаланс фирмы: " + companyBalance() + " zł", backMenu());
    return true;
  }

  // ── приход фирмы вручную
  if (props.getProperty("await_income_" + chatId)) {
    props.deleteProperty("await_income_" + chatId);
    const p = parseAmountNote(text);
    if (!p.amount) { send(chatId, "Не понял сумму. Отменено.", backMenu()); return true; }
    companyAdd("приход", p.amount, p.note || "ручной приход", user.name, ""); SpreadsheetApp.flush();
    send(chatId, "➕ Приход: " + p.amount + " zł — " + (p.note || "ручной") + "\nБаланс фирмы: " + companyBalance() + " zł", backMenu());
    return true;
  }

  // ── старый подряд фикс. суммой
  const awaitCar = props.getProperty("await_contract_" + chatId);
  if (awaitCar && isAdmin(user)) {
    props.deleteProperty("await_contract_" + chatId);
    const amount = parseAmount(text);
    if (!amount) { send(chatId, "Не понял сумму. Отменено.", backMenu()); return true; }
    const car = findCar(awaitCar);
    if (!car) { send(chatId, "Машина не найдена.", backMenu()); return true; }
    setCell(car._row, A.TYPE, "подряд"); setCell(car._row, A.CONTRACT, amount);
    setCell(car._row, A.STATUS, "в работе"); setCell(car._row, A.WORKER, "Виталий");
    setCell(car._row, A.STAGE, "Подряд (Виталий)"); setCell(car._row, A.START, now());
    SpreadsheetApp.flush();
    sheet("Логи").appendRow([now(), awaitCar, car[A.PLATE-1], "Виталий", "Подряд", "", now(), "", "", amount, "ручная сумма (подряд)"]);
    send(chatId, "✅ Машина " + awaitCar + " отдана Виталию. Начислено: " + amount + " zł.", backMenu());
    return true;
  }

  return false;
}

function parseAmount(text) {
  const m = String(text).match(/([\d\s.,]+)/);
  if (!m) return 0;
  return Number(m[1].replace(/\s/g, "").replace(",", ".")) || 0;
}
function parseAmountNote(text) {
  const t = String(text).trim();
  const m = t.match(/([\d\s.,]+)/);
  if (!m) return { amount: 0, note: "" };
  return { amount: Number(m[1].replace(/\s/g, "").replace(",", ".")) || 0, note: t.replace(m[1], "").trim() };
}
function parseSplitPayment(text) {
  let note = "";
  let body = String(text);
  const semi = body.indexOf(";");
  if (semi !== -1) { note = body.slice(semi + 1).trim(); body = body.slice(0, semi); }
  const t = body.toLowerCase().trim();
  let cash = 0, card = 0, matched = false;
  const cashM = t.match(/([\d\s.,]+)\s*(нал|наличн|кеш|cash|got)/);
  if (cashM) { cash = Number(cashM[1].replace(/\s/g, "").replace(",", ".")) || 0; matched = true; }
  const cardM = t.match(/([\d\s.,]+)\s*(карт|card|terminal|безнал)/);
  if (cardM) { card = Number(cardM[1].replace(/\s/g, "").replace(",", ".")) || 0; matched = true; }
  if (!matched) {
    const bare = t.match(/^([\d\s.,]+)$/);
    if (bare) { cash = Number(bare[1].replace(/\s/g, "").replace(",", ".")) || 0; matched = cash > 0; }
  }
  return { ok: matched && (cash > 0 || card > 0), cash: cash, card: card, note: note };
}


// ═══════════════════ СБРОС ТЕСТА ═══════════════════
function pullFromGoogleAsk(chatId, user) {
  if (!isAdmin(user)) return;
  if (typeof __PULL_FROM_GOOGLE__ === "function") __PULL_FROM_GOOGLE__();
  send(chatId, "⬇️ Запросил синхронизацию из Google-таблицы в базу бота.\n" +
    "Правки из таблицы подтянутся в течение ~1 минуты (по одному листу).\n\n" +
    "⚠️ Делай это только когда сам менял таблицу руками — иначе свежие данные бота перезапишутся данными из Google.", backMenu());
}
function testResetAsk(chatId, user) {
  if (!isAdmin(user)) return;
  send(chatId, "🧹 СБРОС ТЕСТА\n\nЭто действие:\n" +
    "• вернёт ВСЕ машины в очередь (в т.ч. выданные)\n" +
    "• очистит этап/мастер/старт у машин\n" +
    "• ОЧИСТИТ ПОЛНОСТЬЮ: Логи, Выплаты, Смены, Кассу (нал), Безнал, Фирму, Клиентов, Доступы, Помощь, Фото, Ошибки\n\n" +
    "⚠️ Отменить нельзя. Делать только перед боевым стартом.\nПродолжить?", {
    inline_keyboard: [
      [{ text: "🧹 Да, очистить ВСЁ", callback_data: "testreset_yes" }],
      [{ text: "⬅️ Нет, отмена", callback_data: "admin" }]] });
}
function clearSheetKeepHeader(sheetName) {
  const sh = db().getSheetByName(sheetName);
  if (!sh) return;
  const last = sh.getLastRow();
  if (last > 1) sh.deleteRows(2, last - 1);
}
function testResetDo(chatId, user) {
  if (!isAdmin(user)) return;
  const sh = sheet("Авто");
  if (sh.getLastRow() > 1) {
    const rows = autoRows();
    rows.forEach(function (r) {
      setCell(r._row, A.STATUS, "в очереди");
      setCell(r._row, A.STAGE, ""); setCell(r._row, A.WORKER, "");
      setCell(r._row, A.START, ""); setCell(r._row, A.PLAN, "");
    });
  }
  ["Логи", "Выплаты", "Смены", "КассаНал", "Безнал", "Фирма", "КлиентыСани", "Доступы",
   "Помощь", "Фото", "Ошибки"]
    .forEach(clearSheetKeepHeader);

  const props = PropertiesService.getScriptProperties();
  ["await_issue_", "await_extra_", "await_cash_", "await_card_", "await_collect_",
   "await_expense_", "await_income_", "await_grant_", "await_paypart_",
   "await_contract_", "await_late_", "await_early_", "await_geo_",
   "await_photo_", "await_help_"]
    .forEach(function (k) { props.deleteProperty(k + chatId); });
  const allKeys = props.getProperties();
  Object.keys(allKeys).forEach(function (k) {
    if (k.indexOf("idle_") === 0 || k.indexOf("pausesum_") === 0 || k.indexOf("pausestart_") === 0 ||
        k.indexOf("await_photo_") === 0 || k.indexOf("await_help_") === 0 ||
        k.indexOf("nightping_") === 0 || k.indexOf("errnotified_") === 0)
      props.deleteProperty(k);
  });
  props.deleteProperty("photo_queue");
  // кэш парсера НЕ трогаем (файлы в Drive не изменились). Для полного пересканирования:
  // props.deleteProperty("parsed_files");

  SpreadsheetApp.flush();
  send(chatId, "🧹 Готово. Все машины в очереди, движения очищены.\n" +
    "Стартовая ЗП в листе «Персонал» НЕ тронута.\n\nМожно начинать боевую работу.", backMenu());
}


// ═══════════════════ НАПОМИНАНИЯ О БЕЗДЕЙСТВИИ ═══════════════════
const IDLE_PING_SEC = 60;
const IDLE_AUTOBREAK_SEC = 180;

function markWaiting(chatId) {
  const p = PropertiesService.getScriptProperties();
  p.setProperty("idle_since_" + chatId, String(Date.now()));
  p.deleteProperty("idle_lastping_" + chatId);
}
function clearWaiting(chatId) {
  const p = PropertiesService.getScriptProperties();
  p.deleteProperty("idle_since_" + chatId);
  p.deleteProperty("idle_lastping_" + chatId);
}
function clearInputWaits(chatId) {
  const p = PropertiesService.getScriptProperties();
  ["await_cash_", "await_card_", "await_issue_", "await_extra_", "await_collect_",
   "await_expense_", "await_income_", "await_paypart_", "await_photo_", "await_help_"]
    .forEach(function (k) { p.deleteProperty(k + chatId); });
}
function INSTALL_IDLE_TRIGGER() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "idleCheckTick") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("idleCheckTick").timeBased().everyMinutes(1).create();
  Logger.log("Триггер напоминаний установлен (раз в минуту).");
}
function idleCheckTick() {
  resetCache();
  const p = PropertiesService.getScriptProperties();
  const all = p.getProperties();
  const nowMs = Date.now();
  Object.keys(all).forEach(function (key) {
    if (key.indexOf("idle_since_") !== 0) return;
    const chatId = key.substring("idle_since_".length);
    const since = Number(all[key]) || 0;
    if (!since) return;
    const elapsed = (nowMs - since) / 1000;
    const user = getStaffByTelegram(chatId);
    if (!user) { clearWaiting(chatId); return; }
    const last = lastShiftEvent(user.name);
    const onShift = last && (last.event === "пришёл" || last.event === "возврат");
    const hasCarInWork = autoRows().some(function (r) {
      return String(r[A.WORKER-1]).trim() === user.name && String(r[A.STATUS-1]).trim() === "в работе";
    });
    if (!onShift || hasCarInWork) { clearWaiting(chatId); return; }
    if (elapsed >= IDLE_AUTOBREAK_SEC) {
      shiftLog(user.name, "перерыв", "", "авто-перерыв (3 мин без активности)");
      clearWaiting(chatId);
      SpreadsheetApp.flush();
      send(chatId, "⏸ Прошло 3 минуты без работы — тебе поставлен ПЕРЕРЫВ.\nКогда продолжишь — жми «Вернулся с обеда».",
        { inline_keyboard: [[{ text: "↩️ Вернулся с обеда", callback_data: "sh_back" }]] });
      notifyAdmin("⏸ " + user.name + ": авто-перерыв — 3 мин не брал работу.");
      return;
    }
    const minute = Math.floor(elapsed / 60);
    if (minute >= 1 && String(all["idle_lastping_" + chatId] || "") !== String(minute)) {
      p.setProperty("idle_lastping_" + chatId, String(minute));
      const leftMin = Math.max(1, Math.ceil((IDLE_AUTOBREAK_SEC - elapsed) / 60));
      send(chatId, "⏰ " + user.name + ", возьми машину из очереди — что делаешь?\n" +
        "Через " + leftMin + " мин без выбора встанет авто-перерыв.",
        { inline_keyboard: [[{ text: "🚗 К очереди / меню", callback_data: "menu" }]] });
    }
  });
}


// ═══════════════════ WEBHOOK ═══════════════════
function SETUP_WEBHOOK() {
  const url = ScriptApp.getService().getUrl();
  if (!url) { Logger.log("Сначала задеплой как веб-приложение."); return; }
  const res = tg("setWebhook", { url: url, drop_pending_updates: true });
  Logger.log("URL: " + url);
  Logger.log(res.ok ? "✅ ГОТОВО. Открой бота, /start" : "⚠️ " + JSON.stringify(res));
}
function CHECK_WEBHOOK() {
  const r = UrlFetchApp.fetch("https://api.telegram.org/bot" + cfg("TELEGRAM_TOKEN") + "/getWebhookInfo", { muteHttpExceptions: true });
  Logger.log(r.getContentText());
}
function SET_WEBHOOK_MANUAL() {
  const url = "https://script.google.com/macros/s/AKfycbzng8rBatm2wJiRvmHcyox6wXSXDxcpxvQDZrUaWr5uHPlh-RyfhnoH7KUvKUHVYFyj/exec";
  const res = tg("setWebhook", { url: url, drop_pending_updates: true });
  Logger.log(JSON.stringify(res));
}


// ═══════════════════════════════════════════════════════════
// НОВЫЕ БЛОКИ v5
// ═══════════════════════════════════════════════════════════

// ─────────────── ФОТО ДО/ПОСЛЕ ───────────────
function getPhotoSheet() {
  let sh = db().getSheetByName("Фото");
  if (!sh) { sh = db().insertSheet("Фото");
    sh.getRange(1,1,1,6).setValues([["Когда","Машина","Тип","Кто","Ссылка","Статус"]]);
    sh.setFrozenRows(1); }
  return sh;
}
// Сколько фото данной фазы ("до"/"после") уже есть по машине.
function photoCount(carId, phase) {
  const cid = String(carId).trim(), ph = String(phase).trim();
  const rows = sheetValues("Фото", 6);
  let n = 0;
  for (let i = 0; i < rows.length; i++)
    if (String(rows[i][1]).trim() === cid && String(rows[i][2]).trim() === ph) n++;
  return n;
}
const MIN_PHOTOS = 4; // минимум фото до и минимум после

function photoAsk(chatId, user, carId, phase) {
  const car = findCar(carId);
  if (!car) { send(chatId, "Машина не найдена.", backMenu()); return; }
  PropertiesService.getScriptProperties().setProperty("await_photo_" + chatId, carId + "|" + phase);
  // Для до/после требуем минимум MIN_PHOTOS штук.
  const isBA = (phase === "до" || phase === "после");
  const have = isBA ? photoCount(carId, phase) : 0;
  let need = "";
  if (isBA) need = "\n\n📊 Уже принято: " + have + " из минимум " + MIN_PHOTOS + ".";
  send(chatId, "📸 Пришли фото «" + phase + "» для " + (car[A.MODEL-1] || carId) + " — " + (car[A.PLATE-1] || "") +
    ".\nМожно несколько подряд. Каждое запишу." + need + "\n\nКогда закончишь — жми «Готово».", {
    inline_keyboard: [[{ text: "✅ Готово", callback_data: "photo_done:" + carId + ":" + phase }],
                      [{ text: "⬅️ В меню", callback_data: "menu" }]] });
}
// Умная кнопка «Готово» после серии фото.
function photoDone(chatId, user, carId, phase) {
  const isBA = (phase === "до" || phase === "после");
  if (isBA) {
    const have = photoCount(carId, phase);
    if (have < MIN_PHOTOS) {
      // ещё ждём фото — остаёмся в режиме приёма
      PropertiesService.getScriptProperties().setProperty("await_photo_" + chatId, carId + "|" + phase);
      send(chatId, "⚠️ Нужно минимум " + MIN_PHOTOS + " фото «" + phase + "». Принято " + have +
        ". Пришли ещё " + (MIN_PHOTOS - have) + ".", {
        inline_keyboard: [[{ text: "✅ Готово", callback_data: "photo_done:" + carId + ":" + phase }],
                          [{ text: "⬅️ В меню", callback_data: "menu" }]] });
      return;
    }
  }
  clearWaiting(chatId);
  const car = findCar(carId);
  // Если этап уже идёт — вернуть на экран этапа; иначе — к выбору этапа.
  if (car && String(car[A.STATUS-1]).trim() === "в работе") {
    resumeStageScreen(chatId, user, carId);
  } else if (isContractor(user)) {
    grantChooseStage(chatId, user, carId);
  } else {
    chooseStage(chatId, user, carId);
  }
}
function handlePhotoInput(chatId, msg, user) {
  const props = PropertiesService.getScriptProperties();
  const waiting = props.getProperty("await_photo_" + chatId);
  if (!waiting) return false;
  if (!msg.photo || !msg.photo.length) return false;
  const sep = waiting.split("|");
  const carId = sep[0], phase = sep[1] || "до";
  const best = msg.photo[msg.photo.length - 1];
  const fileId = best.file_id;
  getPhotoSheet().appendRow([now(), carId, phase, user.name, "", "очередь"]);
  const qRaw = props.getProperty("photo_queue") || "[]";
  let q; try { q = JSON.parse(qRaw); } catch (e) { q = []; }
  q.push({ fileId: fileId, carId: carId, phase: phase, who: user.name, when: now() });
  if (q.length > 200) q = q.slice(q.length - 200);
  props.setProperty("photo_queue", JSON.stringify(q));
  return true;
}
function flushPhotoQueue() {
  const props = PropertiesService.getScriptProperties();
  const qRaw = props.getProperty("photo_queue");
  if (!qRaw) return;
  let q; try { q = JSON.parse(qRaw); } catch (e) { q = []; }
  if (!q.length) return;
  const token = cfg("TELEGRAM_TOKEN");
  const rootId = cfg("DRIVE_FOLDER_ID");
  if (!token || !rootId) return;
  let processed = 0;
  const MAX_PER_TICK = 2;  // было 5 — большие серии фото подвешивали ответы боту (query too old)
  while (q.length && processed < MAX_PER_TICK) {
    const item = q.shift();
    try {
      const gf = UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/getFile?file_id=" + item.fileId, { muteHttpExceptions: true });
      const gfj = JSON.parse(gf.getContentText());
      if (!gfj.ok) { processed++; continue; }
      const path = gfj.result.file_path;
      const blob = UrlFetchApp.fetch("https://api.telegram.org/file/bot" + token + "/" + path, { muteHttpExceptions: true }).getBlob();
      const folder = getOrderFolder(rootId, item.carId);
      const fname = item.phase + "_" + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd_HHmmss") + ".jpg";
      const saved = folder.createFile(blob.setName(fname));
      markPhotoDone(item.carId, item.phase, saved.getUrl());
      processed++;
    } catch (e) { logErrorSafe("flushPhotoQueue", e); processed++; }
  }
  props.setProperty("photo_queue", JSON.stringify(q));
}
// ═══════════ АВТОУДАЛЕНИЕ ФОТО СТАРШЕ 45 ДНЕЙ ═══════════
// Раз в сутки обходим папки машин в DRIVE_FOLDER_ID и переносим в корзину
// файлы (фото), которым больше PHOTO_TTL_DAYS дней. Удаляем ТОЛЬКО фото с Drive
// (папки и записи в таблицах не трогаем).
const PHOTO_TTL_DAYS = 45;
function cleanupOldPhotos() {
  const rootId = cfg("DRIVE_FOLDER_ID");
  if (!rootId) return;
  const cutoff = Date.now() - PHOTO_TTL_DAYS * 24 * 60 * 60 * 1000;
  let root;
  try { root = DriveApp.getFolderById(rootId); }
  catch (e) { Logger.log("cleanupOldPhotos: нет корневой папки"); return; }
  let removed = 0, scanned = 0;
  const MAX_REMOVE_PER_RUN = 500; // защита от залпа по лимитам Drive
  const folders = root.getFolders();
  while (folders.hasNext() && removed < MAX_REMOVE_PER_RUN) {
    const folder = folders.next();
    let files;
    try { files = folder.listFilesWithDates(); } catch (e) { continue; }
    for (let i = 0; i < files.length && removed < MAX_REMOVE_PER_RUN; i++) {
      const f = files[i];
      // пропускаем вложенные папки, если вдруг попались
      if (f.mimeType === "application/vnd.google-apps.folder") continue;
      scanned++;
      const created = f.createdTime ? Date.parse(f.createdTime) : NaN;
      if (!isNaN(created) && created < cutoff) {
        try { DriveApp.getFileById(f.id).setTrashed(true); removed++; }
        catch (e) { Logger.log("cleanupOldPhotos trash fail " + f.id + ": " + e); }
      }
    }
  }
  if (removed > 0) Logger.log("cleanupOldPhotos: удалено " + removed + " фото старше " + PHOTO_TTL_DAYS + " дней (просмотрено " + scanned + ")");
}
function cleanupOldPhotosTick() {
  try { cleanupOldPhotos(); }
  catch (e) { Logger.log("cleanupOldPhotosTick: " + e); }
}

function getOrderFolder(rootId, carId) {
  const root = DriveApp.getFolderById(rootId);
  const it = root.getFoldersByName(carId);
  if (it.hasNext()) return it.next();
  return root.createFolder(carId);
}
function markPhotoDone(carId, phase, link) {
  const sh = getPhotoSheet();
  if (sh.getLastRow() < 2) return;
  const rows = sh.getRange(2,1,sh.getLastRow()-1,6).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][1]).trim() === String(carId).trim() &&
        String(rows[i][2]).trim() === String(phase).trim() &&
        String(rows[i][5]).trim() === "очередь") {
      sh.getRange(i+2, 5).setValue(link);
      sh.getRange(i+2, 6).setValue("готово");
      return;
    }
  }
}
function logErrorSafe(where, e) {
  try { if (typeof logError === "function") logError(where, e); else Logger.log(where + ": " + e); }
  catch (_) { Logger.log(where + ": " + e); }
}


// ─────────────── ПОМОЩНИК НА ЭТАПЕ ───────────────
function getHelpSheet() {
  let sh = db().getSheetByName("Помощь");
  if (!sh) { sh = db().insertSheet("Помощь");
    sh.getRange(1,1,1,8).setValues([["Машина","Этап","Основной","Помощник","Сумма","Описание","Статус","Когда"]]);
    sh.setFrozenRows(1); }
  return sh;
}
function helpAsk(chatId, user, carId) {
  const car = findCar(carId);
  if (!car) { send(chatId, "Машина не найдена.", backMenu()); return; }
  if (String(car[A.WORKER-1]).trim() !== user.name || String(car[A.STATUS-1]).trim() !== "в работе") {
    send(chatId, "Помощника можно звать только на своём активном этапе.", backMenu()); return;
  }
  const staff = getStaff();
  const kb = [];
  staff.forEach(function (row, i) {
    const u = rowToUser(row, i);
    if (!u.name || !u.active || u.name === user.name) return;
    if (isContractor(u)) return;
    if (!isOnShift(u.name)) return;
    kb.push([{ text: "🤝 " + u.name, callback_data: "help_who:" + carId + ":" + u.row }]);
  });
  if (!kb.length) { send(chatId, "Сейчас на смене нет свободных работников для помощи.", backMenu()); return; }
  kb.push([{ text: "⬅️ Назад к этапу", callback_data: "resume_stage:" + carId }]);
  send(chatId, "🤝 Кого позвать помочь на этапе «" + (car[A.STAGE-1] || "") + "»?\n" +
    "Ты отдашь ему часть своей оплаты за этот этап.", { inline_keyboard: kb });
}
function helpAmountAsk(chatId, user, carId, helperRowStr) {
  const helper = getStaffByRow(Number(helperRowStr));
  if (!helper) { send(chatId, "Работник не найден.", backMenu()); return; }
  const car = findCar(carId);
  if (!car) { send(chatId, "Машина не найдена.", backMenu()); return; }
  const myPay = calcPay(user.name, String(car[A.STAGE-1]).trim(), car);
  PropertiesService.getScriptProperties().setProperty("await_help_" + chatId, carId + "|" + helper.name);
  send(chatId, "🤝 Помощник: " + helper.name + "\nТвоя оплата за этап ≈ " + myPay + " zł.\n\n" +
    "Введи СКОЛЬКО отдаёшь ему и за что (через «;»):\n" +
    "• 50 ; помог с полировкой крыши\n" +
    "• 100 ; мойка колёс и арок\n\n" +
    "Больше своей оплаты за этап отдать нельзя.");
}
function handleHelpInput(chatId, text, user) {
  const props = PropertiesService.getScriptProperties();
  const data = props.getProperty("await_help_" + chatId);
  if (!data) return false;
  props.deleteProperty("await_help_" + chatId);
  const sep = data.split("|");
  const carId = sep[0], helperName = sep[1];
  const car = findCar(carId);
  if (!car) { send(chatId, "Машина не найдена.", backMenu()); return true; }
  let body = String(text), note = "";
  const semi = body.indexOf(";");
  if (semi !== -1) { note = body.slice(semi + 1).trim(); body = body.slice(0, semi); }
  const amount = parseAmount(body);
  if (!amount || amount <= 0) { send(chatId, "Не понял сумму. Отменено.", backMenu()); return true; }
  if (!note) note = "помощь на этапе";
  const stage = String(car[A.STAGE-1]).trim();
  const myPay = calcPay(user.name, stage, car);
  const already = helpPromisedFor(carId, stage, user.name);
  if (amount + already > myPay) {
    send(chatId, "⚠️ Нельзя отдать больше своей оплаты за этап.\n" +
      "Оплата за этап: " + myPay + " zł, уже обещано: " + already + " zł.\n" +
      "Максимум сейчас: " + Math.max(0, Math.round((myPay - already) * 100) / 100) + " zł.", backMenu());
    return true;
  }
  getHelpSheet().appendRow([carId, stage, user.name, helperName, amount, note, "ожидает", now()]);
  SpreadsheetApp.flush();
  const helper = findStaffByName(helperName);
  if (helper && helper.telegram) {
    notify(helper.telegram, "🤝 " + user.name + " зовёт помочь!\n" +
      "🚗 " + (car[A.MODEL-1] || carId) + " — этап «" + stage + "»\n" +
      "💰 Тебе: " + amount + " zł\n📝 " + note + "\n\nБерёшься?", {
      inline_keyboard: [[
        { text: "✅ Беру", callback_data: "help_yes:" + carId + ":" + encodeURIComponent(user.name) },
        { text: "❌ Не могу", callback_data: "help_no:" + carId + ":" + encodeURIComponent(user.name) }]] });
  }
  send(chatId, "✅ Запрос отправлен " + helperName + ". Он подтвердит.\n" +
    "Деньги разделятся, когда закроешь этап.", {
    inline_keyboard: [[{ text: "▶️ Назад к этапу", callback_data: "resume_stage:" + carId }]] });
  return true;
}
function helpPromisedFor(carId, stage, masterName) {
  const sh = getHelpSheet();
  if (sh.getLastRow() < 2) return 0;
  let sum = 0;
  sh.getRange(2,1,sh.getLastRow()-1,8).getValues().forEach(function (r) {
    if (String(r[0]).trim() !== String(carId).trim()) return;
    if (String(r[1]).trim() !== String(stage).trim()) return;
    if (String(r[2]).trim() !== String(masterName).trim()) return;
    const st = String(r[6]).trim();
    if (st === "ожидает" || st === "принято") sum += Number(r[4]) || 0;
  });
  return Math.round(sum * 100) / 100;
}
function helpAccept(chatId, user, carId, encMaster) {
  const master = decodeURIComponent(encMaster);
  const sh = getHelpSheet();
  if (sh.getLastRow() < 2) { send(chatId, "Запрос не найден.", backMenu()); return; }
  const rows = sh.getRange(2,1,sh.getLastRow()-1,8).getValues();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][0]).trim() === String(carId).trim() &&
        String(rows[i][2]).trim() === master &&
        String(rows[i][3]).trim() === user.name &&
        String(rows[i][6]).trim() === "ожидает") {
      sh.getRange(i+2, 7).setValue("принято");
      SpreadsheetApp.flush();
      send(chatId, "✅ Принял помощь по машине " + carId + ".\n" +
        "💰 " + rows[i][4] + " zł начислятся, когда " + master + " закроет этап.", backMenu());
      const m = findStaffByName(master);
      if (m && m.telegram) notify(m.telegram, "🤝 " + user.name + " согласился помочь. Работайте!");
      return;
    }
  }
  send(chatId, "Запрос уже неактуален.", backMenu());
}
function helpDecline(chatId, user, carId, encMaster) {
  const master = decodeURIComponent(encMaster);
  const sh = getHelpSheet();
  if (sh.getLastRow() < 2) { send(chatId, "Запрос не найден.", backMenu()); return; }
  const rows = sh.getRange(2,1,sh.getLastRow()-1,8).getValues();
  for (let i = rows.length - 1; i >= 0; i--) {
    if (String(rows[i][0]).trim() === String(carId).trim() &&
        String(rows[i][2]).trim() === master &&
        String(rows[i][3]).trim() === user.name &&
        String(rows[i][6]).trim() === "ожидает") {
      sh.getRange(i+2, 7).setValue("отклонено");
      SpreadsheetApp.flush();
      send(chatId, "❌ Отклонил. Ок.", backMenu());
      const m = findStaffByName(master);
      if (m && m.telegram) notify(m.telegram, "❌ " + user.name + " не смог помочь по " + carId + ".");
      return;
    }
  }
  send(chatId, "Запрос уже неактуален.", backMenu());
}
function settleHelpOnFinish(carId, stage, masterName, basePay) {
  const sh = getHelpSheet();
  if (sh.getLastRow() < 2) return 0;
  const rows = sh.getRange(2,1,sh.getLastRow()-1,8).getValues();
  let totalToHelpers = 0;
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).trim() !== String(carId).trim()) continue;
    if (String(rows[i][1]).trim() !== String(stage).trim()) continue;
    if (String(rows[i][2]).trim() !== String(masterName).trim()) continue;
    if (String(rows[i][6]).trim() !== "принято") continue;
    let amount = Number(rows[i][4]) || 0;
    const helperName = String(rows[i][3]).trim();
    const note = String(rows[i][5]).trim();
    if (totalToHelpers + amount > basePay) amount = Math.max(0, Math.round((basePay - totalToHelpers) * 100) / 100);
    if (amount <= 0) { sh.getRange(i+2, 7).setValue("разнесено"); continue; }
    const car = findCar(carId);
    const plate = car ? (car[A.PLATE-1] || "") : "";
    sheet("Логи").appendRow([now(), carId, plate, helperName, "Помощь: " + stage, "", "", now(), "", amount,
      "помощь мастеру " + masterName + " · " + note]);
    sh.getRange(i+2, 7).setValue("разнесено");
    totalToHelpers += amount;
    const h = findStaffByName(helperName);
    if (h && h.telegram) notify(h.telegram, "💰 Начислено " + amount + " zł за помощь на «" + stage +
      "» (" + (car ? (car[A.MODEL-1] || carId) : carId) + ").");
  }
  totalToHelpers = Math.round(totalToHelpers * 100) / 100;
  if (totalToHelpers > 0)
    notifyAdmin("🤝 По " + carId + " «" + stage + "»: " + masterName + " отдал помощникам " + totalToHelpers + " zł.");
  return totalToHelpers;
}
function cancelHelpForStage(carId, stage, masterName) {
  const sh = getHelpSheet();
  if (sh.getLastRow() < 2) return;
  const rows = sh.getRange(2,1,sh.getLastRow()-1,8).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).trim() !== String(carId).trim()) continue;
    if (String(rows[i][1]).trim() !== String(stage).trim()) continue;
    if (String(rows[i][2]).trim() !== String(masterName).trim()) continue;
    const st = String(rows[i][6]).trim();
    if (st === "ожидает" || st === "принято") {
      sh.getRange(i+2, 7).setValue("отменено");
      const h = findStaffByName(String(rows[i][3]).trim());
      if (h && h.telegram) notify(h.telegram, "↩️ Этап отменён — помощь по " + carId + " аннулирована.");
    }
  }
  SpreadsheetApp.flush();
}


// ─────────────── ОТКАТ ОПЕРАЦИЙ (СТОРНО) ───────────────
function recentMoneyOps(limit) {
  const ops = [];
  const c = getCashSheet();
  if (c.getLastRow() > 1)
    c.getRange(2,1,c.getLastRow()-1,6).getValues().forEach(function (r, i) {
      ops.push({ src: "касса", row: i + 2, when: String(r[0]), type: String(r[1]).trim(),
                 amount: Number(r[2]) || 0, who: String(r[3]), car: String(r[4]), note: String(r[5]) });
    });
  const k = getCardSheet();
  if (k.getLastRow() > 1)
    k.getRange(2,1,k.getLastRow()-1,5).getValues().forEach(function (r, i) {
      ops.push({ src: "карта", row: i + 2, when: String(r[0]), type: "приход",
                 amount: Number(r[1]) || 0, who: String(r[2]), car: String(r[3]), note: String(r[4]) });
    });
  const f = getCompanySheet();
  if (f.getLastRow() > 1)
    f.getRange(2,1,f.getLastRow()-1,6).getValues().forEach(function (r, i) {
      ops.push({ src: "фирма", row: i + 2, when: String(r[0]), type: String(r[1]).trim(),
                 amount: Number(r[2]) || 0, who: String(r[4]), car: "", note: String(r[3]) + " " + String(r[5]) });
    });
  ops.sort(function (a, b) {
    const da = parseDt(a.when), db2 = parseDt(b.when);
    return (db2 ? db2.getTime() : 0) - (da ? da.getTime() : 0);
  });
  return ops.slice(0, limit || 10);
}
function showUndo(chatId, user) {
  if (!isAdmin(user)) { send(chatId, "Только для руководителя.", backMenu()); return; }
  const ops = recentMoneyOps(8);
  if (!ops.length) { send(chatId, "Операций нет.", backMenu()); return; }
  let txt = "↩️ ОТМЕНА ОПЕРАЦИЙ\nВыбери, что сторнировать (создаст обратную запись):\n";
  const kb = [];
  ops.forEach(function (o, idx) {
    if (/\[СТОРНО\]/i.test(o.note)) return;
    const sign = (o.type === "приход") ? "+" : "−";
    const label = o.src + " " + sign + o.amount + " zł · " + (o.car || o.note || o.who);
    txt += "\n" + (idx + 1) + ") " + o.when + "  " + label;
    kb.push([{ text: "↩️ Отменить: " + label.slice(0, 40), callback_data: "undo:" + o.src + ":" + o.row }]);
  });
  kb.push([{ text: "⬅️ В меню", callback_data: "menu" }]);
  send(chatId, txt, { inline_keyboard: kb });
}
function undoOp(chatId, user, src, rowStr) {
  if (!isAdmin(user)) { send(chatId, "Только для руководителя.", backMenu()); return; }
  const row = Number(rowStr);
  let done = "";
  if (src === "касса") {
    const sh = getCashSheet();
    const r = sh.getRange(row, 1, 1, 6).getValues()[0];
    const type = String(r[1]).trim(), amount = Number(r[2]) || 0;
    if (/\[СТОРНО\]/i.test(String(r[5]))) { send(chatId, "Уже сторнировано.", backMenu()); return; }
    const revType = (type === "приход") ? "инкассация" : "приход";
    cashAdd(revType, amount, user.name, String(r[4]), "СТОРНО строки " + row + " · было: " + (r[5] || type));
    sh.getRange(row, 6).setValue(String(r[5]) + " [СТОРНО]");
    done = "Касса: откат " + amount + " zł. Баланс: " + cashBalance() + " zł";
  } else if (src === "карта") {
    const sh = getCardSheet();
    const r = sh.getRange(row, 1, 1, 5).getValues()[0];
    const amount = Number(r[1]) || 0;
    if (/\[СТОРНО\]/i.test(String(r[4]))) { send(chatId, "Уже сторнировано.", backMenu()); return; }
    cardAdd(-amount, user.name, String(r[3]), "СТОРНО строки " + row);
    companyAdd("расход", amount, "сторно карты", user.name, "откат строки " + row);
    sh.getRange(row, 5).setValue(String(r[4]) + " [СТОРНО]");
    done = "Карта: откат " + amount + " zł (сведено на фирме).";
  } else if (src === "фирма") {
    const sh = getCompanySheet();
    const r = sh.getRange(row, 1, 1, 6).getValues()[0];
    const type = String(r[1]).trim(), amount = Number(r[2]) || 0;
    if (/\[СТОРНО\]/i.test(String(r[5]))) { send(chatId, "Уже сторнировано.", backMenu()); return; }
    const revType = (type === "приход") ? "расход" : "приход";
    companyAdd(revType, amount, "сторно", user.name, "откат строки " + row + " · было: " + (r[3] || ""));
    sh.getRange(row, 6).setValue(String(r[5]) + " [СТОРНО]");
    done = "Фирма: откат " + amount + " zł. Баланс: " + companyBalance() + " zł";
  } else { send(chatId, "Неизвестный источник.", backMenu()); return; }
  SpreadsheetApp.flush();
  notifyAdmin("↩️ " + user.name + " сделал сторно (" + src + ", строка " + row + ").");
  send(chatId, "✅ " + done, backMenu());
}
function unissueCar(chatId, user, carId) {
  if (!isAdmin(user)) { send(chatId, "Только для руководителя.", backMenu()); return; }
  const car = findCar(carId);
  if (!car) { send(chatId, "Машина не найдена.", backMenu()); return; }
  if (String(car[A.STATUS-1]).trim() !== "выдана") {
    send(chatId, "Эта машина не в статусе «выдана».", backMenu()); return;
  }
  setCell(car._row, A.STATUS, "готова к выдаче");
  SpreadsheetApp.flush();
  send(chatId, "↩️ " + (car[A.MODEL-1] || carId) + " возвращена в «готова к выдаче».\n" +
    "⚠️ Если деньги уже приняли — откати их через «Отмена операций».", backMenu());
}


// ─────────────── АНТИХРУПКОСТЬ (САНИТАР) ───────────────
function INSTALL_SANITAR() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "sanitarTick") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("sanitarTick").timeBased().everyMinutes(1).create();
  Logger.log("Санитар установлен (раз в минуту).");
}
function sanitarTick() {
  safe("fixOrphanCars", fixOrphanCars);
  safe("fixOrphanGrants", fixOrphanGrants);
  safe("autoCloseShifts", autoCloseShifts);
  safe("flushPhotoQueue", flushPhotoQueue);
  const mm = new Date().getMinutes();
  // watchdogWebhook удалён — используется long polling, вебхука нет.
  if (mm === 17)             safe("integrityCheck", integrityCheck);
}
function safe(name, fn) {
  resetCache();
  try { fn(); } catch (e) { logError(name, e); }
}
function getErrSheet() {
  let sh = db().getSheetByName("Ошибки");
  if (!sh) { sh = db().insertSheet("Ошибки");
    sh.getRange(1,1,1,3).setValues([["Когда","Где","Текст"]]); sh.setFrozenRows(1); }
  return sh;
}
function logError(where, e) {
  try {
    const msg = (e && e.stack) ? e.stack : String(e);
    getErrSheet().appendRow([now(), where, msg]);
    Logger.log("ERR[" + where + "]: " + msg);
    const p = PropertiesService.getScriptProperties();
    const k = "errnotified_" + where;
    const lastTs = Number(p.getProperty(k)) || 0;
    if (Date.now() - lastTs > 30 * 60000) {
      p.setProperty(k, String(Date.now()));
      notifyAdmin("⚠️ Сбой в «" + where + "». Записан в лист «Ошибки». Система продолжает работу.");
    }
  } catch (_) {}
}
function fixOrphanCars() {
  const rows = autoRows();
  let fixed = 0;
  rows.forEach(function (r) {
    if (String(r[A.STATUS-1]).trim() !== "в работе") return;
    const noWorker = !String(r[A.WORKER-1]).trim();
    const noStart  = !String(r[A.START-1]).trim();
    if (noWorker || noStart) {
      setCell(r._row, A.STATUS, "в очереди");
      setCell(r._row, A.STAGE, ""); setCell(r._row, A.WORKER, "");
      setCell(r._row, A.START, ""); setCell(r._row, A.PLAN, "");
      fixed++;
    }
  });
  if (fixed) { SpreadsheetApp.flush(); notifyAdmin("🔧 Санитар: вернул в очередь зависших машин: " + fixed + "."); }
}
function fixOrphanGrants() {
  const sh = getGrantSheet();
  if (sh.getLastRow() < 2) return;
  const rows = sh.getRange(2,1,sh.getLastRow()-1,5).getValues();
  let fixed = 0;
  rows.forEach(function (r, i) {
    if (String(r[3]).trim() !== "открыт") return;
    const car = findCar(String(r[0]).trim());
    const gone = !car || String(car[A.STATUS-1]).trim() === "выдана";
    if (gone) { sh.getRange(i+2, 4).setValue("закрыт"); fixed++; }
  });
  if (fixed) { SpreadsheetApp.flush(); notifyAdmin("🔧 Санитар: закрыл зависших доступов: " + fixed + "."); }
}
function autoCloseShifts() {
  const d = new Date();
  const hour = d.getHours();
  const staff = getStaff();
  staff.forEach(function (row, i) {
    const u = rowToUser(row, i);
    if (!u.name || !u.telegram) return;
    if (!isOnShift(u.name)) return;
    const startStr = findShiftStart(u.name);
    if (!startStr) return;
    const start = parseDt(startStr);
    if (!start) return;
    const hoursOpen = (d - start) / 3600000;
    if (hour >= 3 && hour < 8 && hoursOpen >= 3) {
      const mins = minutesBetween(startStr, now());
      shiftLog(u.name, "ушёл", "", mins);
      appendShiftComment(u.name, "авто-закрытие после 03:00, время неточное");
      SpreadsheetApp.flush();
      send(u.telegram, "🔴 Смена авто-закрыта в " + now() + " (после 3:00).\n" +
        "Если работал дольше — скажи руководителю, поправит.");
      notifyAdmin("🌙 Авто-закрыл смену " + u.name + " (после 3:00, ≈ " + fmtDur(mins) + "). Время неточное.");
      return;
    }
    if (hour === 2) {
      const p = PropertiesService.getScriptProperties();
      const k = "nightping_" + u.telegram + "_" + Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyyMMdd");
      if (!p.getProperty(k)) {
        p.setProperty(k, "1");
        notify(u.telegram, "🌙 " + u.name + ", ты ещё на смене (уже " + fmtDur(minutesBetween(startStr, now())) + ").\n" +
          "Как закончишь — жми «Ушёл с работы». После 3:00 закрою автоматически.");
      }
    }
  });
}
function watchdogWebhook() {
  // Отключён в Node-порту: бот работает через long polling, вебхука нет.
}
function integrityCheck() {
  const problems = [];
  if (cashBalance() < -0.01) problems.push("Касса ушла в минус: " + cashBalance() + " zł");
  autoRows().forEach(function (r) {
    if (String(r[A.STATUS-1]).trim() === "в работе") {
      if (!String(r[A.STAGE-1]).trim()) problems.push("Машина " + r[A.ID-1] + " в работе без этапа");
    }
  });
  if (problems.length) {
    const p = PropertiesService.getScriptProperties();
    const lastTs = Number(p.getProperty("integrity_notified")) || 0;
    if (Date.now() - lastTs > 60 * 60000) {
      p.setProperty("integrity_notified", String(Date.now()));
      notifyAdmin("🩺 Проверка целостности нашла:\n• " + problems.join("\n• ") +
        "\n\nЭто предупреждение, система работает.");
    }
  }
}


// ─────────────── ЕЖЕДНЕВНАЯ СВОДКА ───────────────
function INSTALL_DAILY_REPORT() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "dailyReportTick") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("dailyReportTick").timeBased().atHour(23).everyDays(1).create();
  Logger.log("Ежедневная сводка установлена на 23:00.");
}
function dailyReportTick() {
  safe("dailyReport", function () {
    const id = adminChatId();
    if (!id) return;
    const d = new Date();
    const from = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
    const to   = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0);
    const dayPeriod = { from: from, to: to };
    const cashIn = cashInTotal(dayPeriod);
    const card   = cardTotal(dayPeriod);
    const sh = getShiftSheet();
    const hours = {};
    if (sh.getLastRow() > 1)
      sh.getRange(2,1,sh.getLastRow()-1,6).getValues().forEach(function (r) {
        if (String(r[2]).trim() !== "ушёл") return;
        const dt = parseDt(r[0]);
        if (!dt || dt < from || dt >= to) return;
        const n = String(r[1]).trim();
        hours[n] = (hours[n] || 0) + (Number(r[4]) || 0);
      });
    let txt = "🌆 ИТОГ ДНЯ — " + Utilities.formatDate(d, Session.getScriptTimeZone(), "dd.MM.yyyy") + "\n";
    txt += "\n💵 Нал принято: " + cashIn + " zł";
    txt += "\n💳 Карта: " + card + " zł";
    txt += "\n━━ Выручка за день: " + Math.round((cashIn + card) * 100) / 100 + " zł";
    txt += "\n\n📦 В кассе сейчас: " + cashBalance() + " zł";
    txt += "\n🏦 Баланс фирмы: " + companyBalance() + " zł";
    txt += dayStatsText(from, to);
    notify(id, txt);
  });
}


// ─────────────── ФОНОВАЯ СИНХРОНИЗАЦИЯ DRIVE ───────────────
function INSTALL_SYNC_TRIGGER() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "syncQueueTick") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("syncQueueTick").timeBased().everyMinutes(5).create();
  Logger.log("Фоновая синхронизация Drive установлена (раз в 5 минут).");
}
function syncQueueTick() {
  resetCache();
  try {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) return;
    try { syncQueue(); } finally { lock.releaseLock(); }
  } catch (e) { Logger.log("syncQueueTick: " + e); }
}

  // ─────────── ЭКСПОРТ ДЛЯ NODE-ПОРТА ───────────
  return {
    onMessage, onCallback,
    sanitarTick, dailyReportTick, syncQueueTick, idleCheckTick,
    syncQueue, flushPhotoQueue, cleanupOldPhotosTick,
    cfg,
  };
}; // конец createKraken
