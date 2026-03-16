// static/js/cookie.js

/**
 * Получает device_id из cookies или генерирует новый.
 * @returns {string} device_id
 */
function getOrCreateDeviceId() {
    // Попытка получить из cookies
    let deviceId = getCookie("device_id");

    if (!deviceId) {
        deviceId = navigator.userAgent.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 20);
        deviceId += "_" + Date.now().toString(36); // добавляем уникальность

        // Сохраняем в cookies на 10 лет
        setCookie("device_id", deviceId, 365 * 10);
        logg(["🆕 Новый device_id сгенерирован и сохранён в cookies:", deviceId]);
    } else {
        // logg(["🔁 device_id загружен из cookies:", deviceId]);
    }

    return deviceId;
}

// --- Вспомогательные функции для работы с cookies ---

/**
 * Устанавливает cookie.
 * @param {string} name - Имя cookie.
 * @param {string} value - Значение cookie.
 * @param {number} days - Срок действия в днях.
 */
function setCookie(name, value, days) {
    let expires = "";
    if (days) {
        const date = new Date();
        date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
        expires = "; expires=" + date.toUTCString();
    }
    // Используем path=/ для доступности на всём сайте
    // SameSite=Lax и Secure для повышения безопасности (Secure требует HTTPS)
    document.cookie = name + "=" + (value || "") + expires + "; path=/; SameSite=Lax;" + (location.protocol === 'https:' ? ' Secure' : '');
}

/**
 * Получает значение cookie по имени.
 * @param {string} name - Имя cookie.
 * @returns {string|null} Значение cookie или null, если не найдено.
 */
function getCookie(name) {
    const nameEQ = name + "=";
    const ca = document.cookie.split(';');
    for (let i = 0; i < ca.length; i++) {
        let c = ca[i];
        while (c.charAt(0) === ' ') c = c.substring(1, c.length);
        if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length, c.length);
    }
    return null;
}

