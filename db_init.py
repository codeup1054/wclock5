# db_init.py
"""
Инициализация и миграция базы данных для парсера погоды.

Этот модуль:
- Создаёт таблицы при первом запуске
- Обновляет схему при изменении (без потери данных)
- Удаляет устаревшие поля: sunrise, sunset, moon_phase
- Добавляет новые поля: wind_dir_full, soil_temp, pollen_level, geomagnetic
- Создаёт таблицу battery_logs для логирования уровня заряда
- Устанавливает стартовые настройки

Путь к БД: parsers/mail.ru/odintsovo_weather.db
"""

import os
import sqlite3

# Путь к базе данных
DB_PATH = os.path.join(os.path.dirname(__file__), "parsers", "mail.ru", "odintsovo_weather.db")

# Стартовые интервалы (в секундах)
DEFAULT_SETTINGS = {
    'MAIL_RU_INTERVAL':       60 * 30,        # 30 минут — парсинг mail.ru
    'REFRESH_DATA_INTERVAL':  60 * 30,        # 30 минут — обновление данных на фронтенде
    'BATTERY_SET_INTERVAL':   60 * 10,        # 10 минут — отправка уровня батареи
    'RELOAD_PAGE_INTERVAL':   3600 * 24 * 3,  # 3 дня — полная перезагрузка страницы
}


def init_db():
    """Инициализирует БД и применяет миграции. Возвращает путь к БД."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    # === 1. Создание таблиц (без устаревших полей) ===
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS current (
            collected_at TEXT,
            datetime TEXT,
            temperature INTEGER,
            feels_like INTEGER,
            description TEXT,
            pressure INTEGER,
            wind_direction TEXT,
            wind_speed INTEGER,
            humidity INTEGER,
            uv_index INTEGER,
            wind_dir_full TEXT,      -- "1 м/с Ю-ЮВ"
            soil_temp REAL,          -- температура почвы
            pollen_level TEXT,       -- уровень пыльцы
            geomagnetic TEXT         -- геомагнитное поле
        )
    """)
    print("✅ Таблица 'current' создана или уже существует")

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS hourly_forecast (
            collected_at TEXT,
            time TEXT,
            temperature INTEGER,
            feels_like INTEGER,
            description TEXT,
            pressure INTEGER,
            wind_direction TEXT,
            wind_speed INTEGER,
            humidity INTEGER,
            precip_prob INTEGER,
            icon_url_light TEXT,
            icon_url_day TEXT
        )
    """)
    print("✅ Таблица 'hourly_forecast' создана или уже существует")

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    """)
    print("✅ Таблица 'settings' создана или уже существует")

    # === 2. Таблица для логов батареи ===
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS battery_logs (
            datetime TEXT NOT NULL,
            device_id TEXT NOT NULL,
            battery_level INTEGER NOT NULL,
            PRIMARY KEY (datetime, device_id)
        )
    """)
    print("✅ Таблица 'battery_logs' создана или уже существует")

    # === 3. Настройки по умолчанию ===
    inserted = 0
    for key, value in DEFAULT_SETTINGS.items():
        cursor.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (key, str(value)))
        if cursor.rowcount > 0:
            inserted += 1

    if inserted:
        print(f"✅ Добавлено {inserted} настроек")
    else:
        print("ℹ️ Настройки уже существуют")

    # === 4. Миграция: удаление устаревших полей + добавление новых ===
    cursor.execute("PRAGMA table_info(current)")
    existing_cols = {row[1] for row in cursor.fetchall()}

    old_fields = {"sunrise", "sunset", "moon_phase"}
    new_fields = {
        "wind_dir_full": "TEXT",
        "soil_temp": "REAL",
        "pollen_level": "TEXT",
        "geomagnetic": "TEXT",
        "icon_url": "TEXT",
    }

    # Если есть старые поля — пересоздаём таблицу без них
    if old_fields & existing_cols:
        print("🔄 Обнаружены устаревшие поля. Выполняется миграция...")

        # Создаём новую таблицу с актуальной схемой
        cursor.execute("""
            CREATE TABLE current_new AS
            SELECT 
                collected_at, datetime, temperature, feels_like, description,
                pressure, wind_direction, wind_speed, humidity, uv_index,
                COALESCE(wind_dir_full, '') AS wind_dir_full,
                soil_temp,
                COALESCE(pollen_level, '') AS pollen_level,
                COALESCE(geomagnetic, '') AS geomagnetic
            FROM current
        """)

        # Заменяем старую таблицу
        cursor.execute("DROP TABLE current")
        cursor.execute("ALTER TABLE current_new RENAME TO current")
        print("✅ Устаревшие поля (sunrise, sunset, moon_phase) удалены")

    # Добавляем недостающие новые поля (на случай частичной миграции)
    for col, typ in new_fields.items():
        if col not in existing_cols:
            try:
                cursor.execute(f"ALTER TABLE current ADD COLUMN {col} {typ}")
                print(f"✅ Добавлена колонка: {col}")
            except sqlite3.OperationalError as e:
                if "duplicate column name" not in str(e):
                    print(f"❌ Ошибка при добавлении {col}: {e}")

    conn.commit()
    conn.close()
    print("\n✅ Инициализация базы данных завершена.\n")
    return DB_PATH


if __name__ == "__main__":
    init_db()