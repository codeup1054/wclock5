import os
import json
import time
import sqlite3
import requests
from datetime import datetime, timezone, timedelta
from bs4 import BeautifulSoup
import re
import signal
import sys

# === URLs ===
URL_24H = "https://pogoda.mail.ru/prognoz/odintsovo/24hours/"
URL_MAIN = "https://pogoda.mail.ru/prognoz/odintsovo/"

# === Отладочный файл ===
JSON_FILE = "odintsovo_24h_debug.json"

# === Импорт общей инициализации БД ===
sys.path.append(os.path.dirname(os.path.dirname(os.path.dirname(__file__))))
from db_init import init_db, DB_PATH

# === Флаг завершения ===
shutdown = False

def signal_handler(sig, frame):
    global shutdown
    print("\n🛑 Получен сигнал завершения. Завершаем работу...")
    shutdown = True

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

# --- Безопасное преобразование в int ---
def safe_int(value, default=None):
    if value is None or value == '':
        return default
    try:
        clean = re.sub(r'[^\d\-]', '', str(value))
        return int(clean) if clean else default
    except (ValueError, TypeError):
        return default


# --- Чтение интервала из БД ---
def get_parse_interval():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT value FROM settings WHERE key = 'MAIL_RU_INTERVAL'")
    row = cursor.fetchone()
    conn.close()
    if row:
        try:
            return max(600, int(row[0]))
        except (ValueError, TypeError):
            pass
    return 1800  # 30 минут по умолчанию

# --- Парсинг 24-часового прогноза ---
def fetch_and_parse_24h():
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    response = requests.get(URL_24H, headers=headers, timeout=15)
    response.raise_for_status()
    soup = BeautifulSoup(response.text, 'html.parser')

    collected_at = datetime.now(timezone(timedelta(hours=3))).isoformat()

    forecast_div = soup.find('div', {'data-module': 'ForecastHour'})
    if not forecast_div:
        raise ValueError("Блок ForecastHour не найден")

    onclick = forecast_div.get('onclick')
    if not onclick:
        raise ValueError("Атрибут onclick не найден")

    match = re.search(r'return\s*({.*})', onclick, re.DOTALL)
    if not match:
        raise ValueError("JSON в onclick не найден")

    raw_data = json.loads(match.group(1))
    data = raw_data['ForecastHour']['data']

    current_raw = data['current']
    city_dt = data['city']['datetime']

    current = {
        "collected_at": collected_at,
        "datetime": city_dt['mysqldatetime'],
        "temperature": safe_int(current_raw.get('temperature')),
        "feels_like": safe_int(current_raw.get('tempe_comf')),
        "description": current_raw.get('description', ''),
        "pressure": safe_int(current_raw.get('pressure')),
        "wind_direction": current_raw.get('wind_direction', ''),
        "wind_speed": safe_int(current_raw.get('wind_speed')),
        "humidity": safe_int(current_raw.get('humidity')),
        "uv_index": safe_int(current_raw.get('uv_index')),
        "wind_dir_full": current_raw.get('wind_dir_full', ''),
        "soil_temp": safe_int(current_raw.get('soil_temp')),
        "pollen_level": safe_int(current_raw.get('pollen_level')),
        "geomagnetic": safe_int(current_raw.get('geomagnetic')),
        "icon_url": f"/img/status/icon/2021/dt/svg/{current_raw.get('icon', '00')}.svg"
    }

    hourly = []
    for day in data['dates']:
        base_date = day['datetime']['mysqldate']
        for fc in day['forecasts']:
            if 'type' in fc:
                continue
            hour_time = fc['time']
            iso_time = f"{base_date}T{hour_time}:00+03:00"
            icon_num = fc.get('icon', '00')
            hourly.append({
                "time": iso_time,
                "temperature": safe_int(fc.get('temperature')),
                "feels_like": safe_int(fc.get('tempe_comf')),
                "description": fc.get('description', ''),
                "pressure": safe_int(fc.get('pressure')),
                "wind_direction": fc.get('wind_direction', ''),
                "wind_speed": safe_int(fc.get('wind_speed')),
                "humidity": safe_int(fc.get('humidity')),
                "precip_prob": safe_int(fc.get('precip_prob')),
                "icon_url_light": f"/img/status/icon/2021/lt/svg/{icon_num}.svg",
                "icon_url_day": f"/img/status/icon/2021/dt/svg/{icon_num}.svg"
            })

    return current, hourly

# --- Парсинг доп. данных с главной страницы ---
def fetch_main_page_data():
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    response = requests.get(URL_MAIN, headers=headers, timeout=15)
    response.raise_for_status()
    soup = BeautifulSoup(response.text, 'html.parser')

    # Ищем все карточки с данными "Сегодня"
    today_block = soup.find("div", attrs={"data-logger": "pogoda__MainStat"})
    if not today_block:
        return {}

    # Каждая карточка с параметром погоды
    items = today_block.select("div.c9ef097fde")

    mapping = {
        "Ветер": "wind_dir_full",
        "Почва": "soil_temp",
        "Пыльца": "pollen_level",
        "Геомагнитное поле": "geomagnetic",
        # "Влажность": "humidity",
        # "Давление": "pressure",
        # "Температура": "temperature",
        "Ощущается как": "feels_like",
        "Осадки": "precip_prob",
        "Скорость ветра": "wind_speed"
    }

    extra_data = {}

    for item in items:
        texts = [t.get_text(strip=True) for t in item.select('[data-qa="Text"]')]
        if len(texts) < 2:
            continue

        label = texts[0]
        value = texts[1]

        if label in mapping:
            extra_data[mapping[label]] = value

    return extra_data

# --- Сохранение отладочного JSON ---
def save_to_json_debug(current, hourly, extra_data):
    debug_data = {"current": current, "forecast": hourly, "extra": extra_data}
    
    production = True
    
    if production == False:
        with open(JSON_FILE, 'w', encoding='utf-8') as f:
            json.dump(debug_data, f, ensure_ascii=False, indent=2)
        print(f"📁 Отладочные данные сохранены в {JSON_FILE}")

# --- Сохранение в SQLite ---
def save_to_sqlite(current, hourly, extra_data):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    # === УДАЛЕНИЕ данных старше 7 дней ===
    cutoff = "datetime('now', '-7 days')"
    
    # Таблица current: используем collected_at
    cursor.execute(f"DELETE FROM current WHERE collected_at < {cutoff}")
    
    # Таблица hourly_forecast: используем time
    cursor.execute(f"DELETE FROM hourly_forecast WHERE time < {cutoff}")
    
    # Таблица battery_logs (если есть): используем datetime
    cursor.execute(f"DELETE FROM battery_logs WHERE datetime < {cutoff}")

    # === ВСТАВКА новых данных ===
    current_with_extra = current.copy()
    current_with_extra.update(extra_data)

    cursor.execute("""
        INSERT INTO current (
            collected_at, datetime, temperature, feels_like, description,
            pressure, wind_direction, wind_speed, humidity, uv_index,
            wind_dir_full, soil_temp, pollen_level, geomagnetic, icon_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        current_with_extra["collected_at"], current_with_extra["datetime"], current_with_extra["temperature"],
        current_with_extra["feels_like"], current_with_extra["description"], current_with_extra["pressure"],
        current_with_extra["wind_direction"], current_with_extra["wind_speed"], current_with_extra["humidity"],
        current_with_extra["uv_index"], 
        current_with_extra.get("wind_dir_full", ""),
        current_with_extra.get("soil_temp"),
        current_with_extra.get("pollen_level", ""),
        current_with_extra.get("geomagnetic", ""),
        current_with_extra.get("icon_url", "")
    ))

    for h in hourly:
        cursor.execute("""
            INSERT INTO hourly_forecast (
                collected_at, time, temperature, feels_like, description,
                pressure, wind_direction, wind_speed, humidity, precip_prob,
                icon_url_light, icon_url_day
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            current_with_extra["collected_at"], h["time"], h["temperature"], h["feels_like"],
            h["description"], h["pressure"], h["wind_direction"], h["wind_speed"],
            h["humidity"], h["precip_prob"], h["icon_url_light"], h["icon_url_day"]
        ))

    conn.commit()
    conn.close()

# --- Основной цикл ---
def main():
    print("🔄 Запуск парсера погоды в режиме демона")
    print(f"🗃️  База данных: {DB_PATH}")
    print(f"🌐 URL 24h: {URL_24H}")
    print(f"🌐 URL main: {URL_MAIN}")
    print()

    init_db()

    while not shutdown:
        try:
            interval = get_parse_interval()
            print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Запуск парсинга...")

            current, hourly = fetch_and_parse_24h()
            extra_data = fetch_main_page_data()

            save_to_json_debug(current, hourly, extra_data)
            save_to_sqlite(current, hourly, extra_data)
            print(f"✅ Успешно сохранено: {len(hourly)} записей")

        except Exception as e:
            print(f"❌ Ошибка: {e}")
            import traceback
            traceback.print_exc()

        if shutdown:
            break

        print(f"⏳ Ожидание {interval} секунд до следующего запуска...")
        for _ in range(interval):
            if shutdown:
                break
            time.sleep(1)

    print("✅ Парсер завершил работу.")

if __name__ == "__main__":
    main()