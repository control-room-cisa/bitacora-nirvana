import express from 'express';
import cors from 'cors';
import axios from 'axios';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const API_URL = process.env.ENERCLO_API_URL || 'https://www.enerclo-atesspower.com';
const EMAIL = process.env.ENERCLO_EMAIL || process.env.ENERCLO_USERNAME || 'fredy.dominguez@flxgrp.com';
const ENCRYPTED_PASSWORD = process.env.ENERCLO_PASSWORD;
const CHILLER_API_URL = process.env.CHILLER_API_URL || 'http://tegus.arrayanhn.com:3001';

// Dispositivos EnerClo disponibles
const ENERCLO_DEVICES = {
    LUVISA: 'YRG0E2900C',
    NIRVANA: 'MWH0G12002'
} as const;

// Por ahora solo se consulta Nirvana
const ACTIVE_ENERCLO_DEVICE: keyof typeof ENERCLO_DEVICES = 'NIRVANA';
const DEVICE_SN =
    process.env.ENERCLO_DEVICE_SN ||
    ENERCLO_DEVICES[ACTIVE_ENERCLO_DEVICE];

function formatYmd(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function shiftYmdDate(ymd: string, deltaDays: number): string {
    const [y, m, d] = ymd.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    date.setDate(date.getDate() + deltaDays);
    return formatYmd(date);
}

function todayDateParam(reqDate: unknown): string {
    if (typeof reqDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(reqDate)) {
        return reqDate;
    }
    return formatYmd(new Date());
}

interface LoginRequest {
    email: string;
    password?: string | undefined;
}

interface UserData {
    userId: number;
    email: string;
    country: string;
    phone: string;
    headPortraitUrl: string | null;
    token: string;
    firstLogin: boolean;
    username: string;
    type: string;
    company: string | null;
}

interface LoginResponse {
    code: number;
    msg: string;
    data: UserData;
}

interface StatisticsRequest {
    dateType: string;
    masterDeviceSn: string;
    deviceSnList: string[];
    statisticsDate: string;
}

let enercloTokenCache: { token: string; expiresAt: number } | null = null;
const ENERCLO_TOKEN_TTL_MS = 25 * 60 * 1000;

async function getEnercloToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && enercloTokenCache && Date.now() < enercloTokenCache.expiresAt) {
        return enercloTokenCache.token;
    }

    console.log('EnerClo: login para obtener token...');
    const loginResponse = await axios.post<LoginResponse>(`${API_URL}/api/user/login`, {
        email: EMAIL,
        password: ENCRYPTED_PASSWORD
    } satisfies LoginRequest);

    const token = loginResponse.data?.data?.token;
    if (!token) {
        throw Object.assign(new Error('No se pudo obtener el token de EnerClo'), {
            status: 401,
            details: loginResponse.data
        });
    }

    enercloTokenCache = {
        token,
        expiresAt: Date.now() + ENERCLO_TOKEN_TTL_MS
    };
    return token;
}

async function fetchEnercloStatistics(yearMonth: string, token: string) {
    const statisticsPayload: StatisticsRequest = {
        dateType: '2',
        masterDeviceSn: DEVICE_SN,
        deviceSnList: [DEVICE_SN],
        statisticsDate: yearMonth
    };

    return axios.post(`${API_URL}/api/home/getStatisticsCoreData`, statisticsPayload, {
        headers: {
            Authorization: token,
            CompanyType: 'ATESS',
            'Content-Type': 'application/json;charset=UTF-8',
            'Accept-Language': 'en_US'
        },
        timeout: 60000
    });
}

// Endpoint de la API para que el frontend consuma
app.get('/api/stats', async (req, res) => {
    try {
        const monthParam = typeof req.query.month === 'string' ? req.query.month : '';
        const currentDate = new Date();
        const currentMonth = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}`;
        const yearMonth = /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : currentMonth;

        console.log(`Consultando EnerClo device=${DEVICE_SN} month=${yearMonth}`);
        const startedAt = Date.now();

        let token = await getEnercloToken();
        let dataResponse;
        try {
            dataResponse = await fetchEnercloStatistics(yearMonth, token);
        } catch (error) {
            // Token expirado/inválido: renovar una vez y reintentar
            if (axios.isAxiosError(error) && (error.response?.status === 401 || error.response?.status === 403)) {
                token = await getEnercloToken(true);
                dataResponse = await fetchEnercloStatistics(yearMonth, token);
            } else {
                throw error;
            }
        }

        console.log(`EnerClo stats listo en ${Date.now() - startedAt}ms`);
        return res.json(dataResponse.data);
    } catch (error) {
        if (axios.isAxiosError(error)) {
            console.error('Error en la petición API:', error.response?.data || error.message);
            return res.status(500).json({ error: 'Error al consultar EnerClo API', details: error.response?.data });
        }
        if (error && typeof error === 'object' && 'status' in error) {
            const err = error as { status?: number; details?: unknown; message?: string };
            return res.status(err.status || 500).json({
                error: err.message || 'Error de autenticación EnerClo',
                details: err.details
            });
        }
        console.error('Error desconocido:', error);
        return res.status(500).json({ error: 'Error interno del servidor' });
    }
});

const WEATHER_LAT = 14.0723;
const WEATHER_LON = -87.1921;
const WEATHER_TZ = 'America/Tegucigalpa';

function describeWeatherEn(input: {
    cloud_cover_mean?: number | null;
    precipitation_sum?: number | null;
    precipitation_hours?: number | null;
}): string {
    const cloud = Number(input.cloud_cover_mean ?? 0);
    const precip = Number(input.precipitation_sum ?? 0);
    const precipHours = Number(input.precipitation_hours ?? 0);

    if (precip >= 10 || precipHours >= 6) return 'Rainy';
    if (precip >= 2 || precipHours >= 2) {
        return cloud >= 70 ? 'Cloudy with rain' : 'Partly cloudy with showers';
    }
    if (cloud < 20) return 'Sunny';
    if (cloud < 40) return 'Mostly sunny';
    if (cloud < 60) return 'Partly cloudy';
    if (cloud < 80) return 'Mostly cloudy';
    return 'Overcast';
}

async function fetchOpenMeteoDaily(baseUrl: string, start: string, end: string) {
    const response = await axios.get(baseUrl, {
        params: {
            latitude: WEATHER_LAT,
            longitude: WEATHER_LON,
            start_date: start,
            end_date: end,
            daily: 'cloud_cover_mean,precipitation_hours,sunshine_duration,precipitation_sum',
            timezone: WEATHER_TZ
        },
        timeout: 30000
    });
    return response.data;
}

function mapOpenMeteoDaily(payload: any): Record<string, { label: string; cloud_cover_mean: number | null; precipitation_sum: number | null; precipitation_hours: number | null; sunshine_duration: number | null }> {
    const times: string[] = payload?.daily?.time || [];
    const clouds: Array<number | null> = payload?.daily?.cloud_cover_mean || [];
    const precipHours: Array<number | null> = payload?.daily?.precipitation_hours || [];
    const sunshine: Array<number | null> = payload?.daily?.sunshine_duration || [];
    const precipSum: Array<number | null> = payload?.daily?.precipitation_sum || [];
    const days: Record<string, any> = {};

    times.forEach((date, index) => {
        const row = {
            cloud_cover_mean: clouds[index] ?? null,
            precipitation_hours: precipHours[index] ?? null,
            sunshine_duration: sunshine[index] ?? null,
            precipitation_sum: precipSum[index] ?? null
        };
        days[date] = {
            ...row,
            label: describeWeatherEn(row)
        };
    });

    return days;
}

// Clima diario (Open-Meteo archive + forecast) para Tegucigalpa
app.get('/api/weather/range', async (req, res) => {
    try {
        const start = typeof req.query.start === 'string' ? req.query.start : '';
        const end = typeof req.query.end === 'string' ? req.query.end : '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
            return res.status(400).json({ success: false, error: 'Parámetros start/end inválidos (YYYY-MM-DD)' });
        }

        const today = formatYmd(new Date());
        const tasks: Array<Promise<any>> = [];

        // Pasado (y hasta ayer): archive API
        if (start < today) {
            const archiveEnd = end < today ? end : shiftYmdDate(today, -1);
            if (start <= archiveEnd) {
                tasks.push(
                    fetchOpenMeteoDaily('https://archive-api.open-meteo.com/v1/archive', start, archiveEnd)
                        .then(mapOpenMeteoDaily)
                );
            }
        }

        // Hoy y futuro: forecast API
        if (end >= today) {
            const forecastStart = start > today ? start : today;
            tasks.push(
                fetchOpenMeteoDaily('https://api.open-meteo.com/v1/forecast', forecastStart, end)
                    .then(mapOpenMeteoDaily)
            );
        }

        const parts = await Promise.all(tasks);
        const days = Object.assign({}, ...parts);

        return res.json({
            success: true,
            start,
            end,
            latitude: WEATHER_LAT,
            longitude: WEATHER_LON,
            timezone: WEATHER_TZ,
            days
        });
    } catch (error) {
        if (axios.isAxiosError(error)) {
            console.error('Error weather/range:', error.response?.data || error.message);
            return res.status(500).json({
                success: false,
                error: 'Error al consultar Open-Meteo',
                details: error.response?.data || error.message
            });
        }
        return res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});

// Proxy Chiller / Bitácora (evita CORS en el browser)
app.get('/api/chiller/summary-bitacora', async (req, res) => {
    try {
        const date = todayDateParam(req.query.date);
        const response = await axios.get(`${CHILLER_API_URL}/api/chiller/summary-bitacora`, {
            params: { date },
            timeout: 30000
        });
        return res.json(response.data);
    } catch (error) {
        if (axios.isAxiosError(error)) {
            console.error('Error summary-bitacora:', error.response?.data || error.message);
            return res.status(error.response?.status || 500).json({
                success: false,
                error: 'Error al consultar summary-bitacora',
                details: error.response?.data || error.message
            });
        }
        return res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});

app.get('/api/chiller/data/ion_meter_minutos', async (req, res) => {
    try {
        const date = todayDateParam(req.query.date);
        const response = await axios.get(`${CHILLER_API_URL}/api/chiller/data/ion_meter_minutos`, {
            params: { date },
            timeout: 60000
        });
        return res.json(response.data);
    } catch (error) {
        if (axios.isAxiosError(error)) {
            console.error('Error ion_meter_minutos:', error.response?.data || error.message);
            return res.status(error.response?.status || 500).json({
                success: false,
                error: 'Error al consultar ion_meter_minutos',
                details: error.response?.data || error.message
            });
        }
        return res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});

app.get('/api/chiller/data/consumo/aire/segundos/avg', async (req, res) => {
    try {
        const date = todayDateParam(req.query.date);
        const response = await axios.get(`${CHILLER_API_URL}/api/chiller/data/consumo/aire/segundos/avg`, {
            params: { date },
            timeout: 30000
        });
        return res.json(response.data);
    } catch (error) {
        if (axios.isAxiosError(error)) {
            return res.status(error.response?.status || 500).json({
                success: false,
                error: 'Error al consultar consumo aire avg',
                details: error.response?.data || error.message
            });
        }
        return res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});

app.get('/api/chiller/data/consumo/agua/segundos/avg', async (req, res) => {
    try {
        const date = todayDateParam(req.query.date);
        const response = await axios.get(`${CHILLER_API_URL}/api/chiller/data/consumo/agua/segundos/avg`, {
            params: { date },
            timeout: 30000
        });
        return res.json(response.data);
    } catch (error) {
        if (axios.isAxiosError(error)) {
            return res.status(error.response?.status || 500).json({
                success: false,
                error: 'Error al consultar consumo agua avg',
                details: error.response?.data || error.message
            });
        }
        return res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});

app.get('/api/chiller/data/bomba/segundos/avg', async (req, res) => {
    try {
        const date = todayDateParam(req.query.date);
        const table = typeof req.query.table === 'string' ? req.query.table : 'bomba_proceso_segundos';
        const response = await axios.get(`${CHILLER_API_URL}/api/chiller/data/bomba/segundos/avg`, {
            params: { table, date },
            timeout: 30000
        });
        return res.json(response.data);
    } catch (error) {
        if (axios.isAxiosError(error)) {
            return res.status(error.response?.status || 500).json({
                success: false,
                error: 'Error al consultar bomba avg',
                details: error.response?.data || error.message
            });
        }
        return res.status(500).json({ success: false, error: 'Error interno del servidor' });
    }
});

function listDatesInclusive(start: Date, end: Date): string[] {
    const dates: string[] = [];
    const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    while (cursor <= last) {
        dates.push(formatYmd(cursor));
        cursor.setDate(cursor.getDate() + 1);
    }
    return dates;
}

async function fetchIonDayBounds(date: string) {
    try {
        const response = await axios.get(`${CHILLER_API_URL}/api/chiller/data/ion_meter_minutos`, {
            params: { date },
            timeout: 60000
        });
        const payload = response.data;
        const rows = Array.isArray(payload?.data) ? payload.data : [];
        if (!rows.length) {
            return { date, ok: true, empty: true as const };
        }

        // API suele venir de más reciente a más antiguo
        const sorted = [...rows].sort((a: any, b: any) =>
            String(a.fecha_hora).localeCompare(String(b.fecha_hora))
        );
        const first = sorted[0];
        const last = sorted[sorted.length - 1];

        return {
            date,
            ok: true,
            empty: false as const,
            kwh_imp_inicial: first?.kwh_imp ?? null,
            kwh_imp_final: last?.kwh_imp ?? null,
            kwh_exp_inicial: first?.kwh_exp ?? null,
            kwh_exp_final: last?.kwh_exp ?? null,
            first_at: first?.fecha_hora ?? null,
            last_at: last?.fecha_hora ?? null
        };
    } catch (error) {
        const message = axios.isAxiosError(error)
            ? (error.response?.data || error.message)
            : 'Error desconocido';
        return { date, ok: false, empty: true as const, error: message };
    }
}

function resolveMonthBounds(month: string) {
    const [year, monthNum] = month.split('-').map(Number);
    const monthStart = new Date(year, monthNum - 1, 1);
    const monthEnd = new Date(year, monthNum, 0);
    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const effectiveEnd = monthEnd > todayStart ? todayStart : monthEnd;
    return { monthStart, monthEnd, effectiveEnd, isEmpty: monthStart > effectiveEnd };
}

function indexByDate<T extends { date: string }>(items: T[]): Record<string, T> {
    const days: Record<string, T> = {};
    for (const item of items) days[item.date] = item;
    return days;
}

async function fetchSummaryDay(date: string) {
    try {
        const response = await axios.get(`${CHILLER_API_URL}/api/chiller/summary-bitacora`, {
            params: { date },
            timeout: 30000
        });
        const payload = response.data;
        if (!payload?.success || !payload?.data) {
            return { date, ok: true, empty: true as const };
        }
        return {
            date,
            ok: true,
            empty: false as const,
            data: payload.data
        };
    } catch (error) {
        const message = axios.isAxiosError(error)
            ? (error.response?.data || error.message)
            : 'Error desconocido';
        return { date, ok: false, empty: true as const, error: message };
    }
}

async function fetchConsumoAireAvg(date: string) {
    const response = await axios.get(`${CHILLER_API_URL}/api/chiller/data/consumo/aire/segundos/avg`, {
        params: { date },
        timeout: 30000
    });
    return response.data;
}

async function fetchConsumoAguaAvg(date: string) {
    const response = await axios.get(`${CHILLER_API_URL}/api/chiller/data/consumo/agua/segundos/avg`, {
        params: { date },
        timeout: 30000
    });
    return response.data;
}

async function fetchBombaProcesoAvg(date: string) {
    const response = await axios.get(`${CHILLER_API_URL}/api/chiller/data/bomba/segundos/avg`, {
        params: { table: 'bomba_proceso_segundos', date },
        timeout: 30000
    });
    return response.data;
}

async function fetchConsumoAvgDay(date: string) {
    try {
        const [aireRes, aguaRes, bombaRes] = await Promise.all([
            fetchConsumoAireAvg(date),
            fetchConsumoAguaAvg(date),
            fetchBombaProcesoAvg(date)
        ]);

        return {
            date,
            ok: true,
            empty: false as const,
            total_compresor_aire: aireRes?.total_compresor_aire ?? null,
            total_compresor_agua: aguaRes?.total_compresor_agua ?? null,
            consumo_promedio_bomba: bombaRes?.consumo_promedio ?? null
        };
    } catch (error) {
        const message = axios.isAxiosError(error)
            ? (error.response?.data || error.message)
            : 'Error desconocido';
        return {
            date,
            ok: false,
            empty: true as const,
            total_compresor_aire: null,
            total_compresor_agua: null,
            consumo_promedio_bomba: null,
            error: message
        };
    }
}

async function fetchConsumoMonthDays(dates: string[]) {
    return Promise.all(dates.map((date) => fetchConsumoAvgDay(date)));
}

async function fetchSummaryMonthDays(dates: string[]) {
    return Promise.all(dates.map((date) => fetchSummaryDay(date)));
}

async function fetchIonMonthDays(dates: string[]) {
    return Promise.all(dates.map((date) => fetchIonDayBounds(date)));
}

// Consumos promedio del mes: compresor aire/agua + bomba proceso
app.get('/api/chiller/bitacora-consumo-month', async (req, res) => {
    try {
        const month = typeof req.query.month === 'string' ? req.query.month : '';
        if (!/^\d{4}-\d{2}$/.test(month)) {
            return res.status(400).json({ success: false, error: 'Parámetro month inválido (YYYY-MM)' });
        }

        const { monthStart, effectiveEnd, isEmpty } = resolveMonthBounds(month);
        if (isEmpty) {
            return res.json({ success: true, month, days: {} });
        }

        const dates = listDatesInclusive(monthStart, effectiveEnd);
        const dayResults = await fetchConsumoMonthDays(dates);

        return res.json({
            success: true,
            month,
            from: formatYmd(monthStart),
            to: formatYmd(effectiveEnd),
            days: indexByDate(dayResults)
        });
    } catch (error) {
        console.error('Error bitacora-consumo-month:', error);
        return res.status(500).json({ success: false, error: 'Error al agregar consumos avg del mes' });
    }
});

// Agrega summary-bitacora del mes (para CHILLER SYSTEM)
app.get('/api/chiller/bitacora-summary-month', async (req, res) => {
    try {
        const month = typeof req.query.month === 'string' ? req.query.month : '';
        if (!/^\d{4}-\d{2}$/.test(month)) {
            return res.status(400).json({ success: false, error: 'Parámetro month inválido (YYYY-MM)' });
        }

        const { monthStart, effectiveEnd, isEmpty } = resolveMonthBounds(month);
        if (isEmpty) {
            return res.json({ success: true, month, days: {} });
        }

        const dates = listDatesInclusive(monthStart, effectiveEnd);
        const dayResults = await fetchSummaryMonthDays(dates);

        return res.json({
            success: true,
            month,
            from: formatYmd(monthStart),
            to: formatYmd(effectiveEnd),
            days: indexByDate(dayResults)
        });
    } catch (error) {
        console.error('Error bitacora-summary-month:', error);
        return res.status(500).json({ success: false, error: 'Error al agregar summary-bitacora del mes' });
    }
});

// Agrega lecturas ION del mes (+ día anterior/siguiente para deltas)
app.get('/api/chiller/bitacora-ion-month', async (req, res) => {
    try {
        const month = typeof req.query.month === 'string' ? req.query.month : '';
        if (!/^\d{4}-\d{2}$/.test(month)) {
            return res.status(400).json({ success: false, error: 'Parámetro month inválido (YYYY-MM)' });
        }

        const { monthStart, effectiveEnd, isEmpty } = resolveMonthBounds(month);
        if (isEmpty) {
            return res.json({ success: true, month, days: {} });
        }

        const prevDay = new Date(monthStart);
        prevDay.setDate(prevDay.getDate() - 1);
        const nextDay = new Date(effectiveEnd);
        nextDay.setDate(nextDay.getDate() + 1);

        const dates = listDatesInclusive(prevDay, nextDay);
        const dayResults = await fetchIonMonthDays(dates);

        return res.json({
            success: true,
            month,
            from: formatYmd(monthStart),
            to: formatYmd(effectiveEnd),
            days: indexByDate(dayResults)
        });
    } catch (error) {
        console.error('Error bitacora-ion-month:', error);
        return res.status(500).json({ success: false, error: 'Error al agregar datos ION del mes' });
    }
});

// Servir archivos estáticos del directorio "public" (Monolito real sin build step)
const publicPath = path.join(__dirname, '../public');
app.use(express.static(publicPath));

// Fallback global para enviar el index.html en cualquier otra ruta
app.use((req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor backend monolítico corriendo en http://localhost:${PORT}`);
});

