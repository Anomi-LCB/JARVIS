const GEOCODING_ENDPOINT = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
const NOMINATIM_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 12_000;
const NOMINATIM_MIN_INTERVAL_MS = 1_050;
const DAILY_FIELDS = Object.freeze([
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'precipitation_probability_max',
  'precipitation_sum',
  'wind_speed_10m_max',
  'sunrise',
  'sunset'
]);

const KOREAN_WEEKDAYS = Object.freeze(['일', '월', '화', '수', '목', '금', '토']);
const WELL_KNOWN_KOREAN_LOCATIONS = Object.freeze([
  '서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종',
  '제주', '수원', '성남', '고양', '용인', '창원', '청주', '전주',
  '천안', '김해', '포항', '평택', '안산', '안양', '남양주', '화성'
]);
const KOREAN_LOCATION_CENTERS = Object.freeze({
  '서울': [37.5665, 126.9780, '서울특별시'],
  '서울특별시': [37.5665, 126.9780, '서울특별시'],
  '부산': [35.1796, 129.0756, '부산광역시'],
  '부산광역시': [35.1796, 129.0756, '부산광역시'],
  '대구': [35.8714, 128.6014, '대구광역시'],
  '인천': [37.4563, 126.7052, '인천광역시'],
  '광주': [35.1595, 126.8526, '광주광역시'],
  '대전': [36.3504, 127.3845, '대전광역시'],
  '울산': [35.5384, 129.3114, '울산광역시'],
  '세종': [36.4800, 127.2890, '세종특별자치시'],
  '제주': [33.4996, 126.5312, '제주시'],
  '수원': [37.2636, 127.0286, '수원시'],
  '성남': [37.4202, 127.1262, '성남시'],
  '고양': [37.6584, 126.8320, '고양시'],
  '용인': [37.2411, 127.1776, '용인시'],
  '창원': [35.2285, 128.6811, '창원시'],
  '청주': [36.6424, 127.4890, '청주시'],
  '전주': [35.8242, 127.1480, '전주시'],
  '천안': [36.8151, 127.1139, '천안시'],
  '김해': [35.2285, 128.8894, '김해시'],
  '포항': [36.0190, 129.3435, '포항시']
});

export class OpenMeteoWeatherClient {
  constructor({
    fetchImpl = globalThis.fetch,
    clock = () => new Date(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    nominatimEndpoint = process.env.JARVIS_GEOCODING_API_URL ?? NOMINATIM_ENDPOINT
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('Weather client requires fetchImpl.');
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.timeoutMs = clampInteger(timeoutMs, 1_000, 60_000, DEFAULT_TIMEOUT_MS);
    this.nominatimEndpoint = normalizeGeocodingEndpoint(nominatimEndpoint);
    this.geocodingCache = new Map();
    this.lastNominatimRequestAt = 0;
    this.nominatimSchedule = Promise.resolve();
  }

  async weeklyForecast(location, options = {}) {
    assertNotCancelled(options.signal);
    const query = normalizeLocation(location);
    if (!query) throw weatherError('B_WEATHER_LOCATION_REQUIRED', '날씨를 조회할 지역이 필요합니다.');
    const place = await this.geocode(query, options);
    const forecast = await this.forecast(place, options);
    assertNotCancelled(options.signal);
    return {
      reportVersion: 'jarvis-weather-weekly-report-v1',
      query,
      location: place,
      timezone: forecast.timezone,
      timezoneAbbreviation: forecast.timezoneAbbreviation,
      units: forecast.units,
      days: forecast.days,
      statistics: calculateWeatherStatistics(forecast.days),
      source: {
        provider: 'Open-Meteo',
        geocodingProvider: place.geocodingProvider ?? 'Open-Meteo Geocoding',
        geocodingAttribution: place.attribution ?? null,
        geocodingUrl: place.sourceUrl,
        forecastUrl: forecast.sourceUrl,
        retrievedAt: this.clock().toISOString()
      }
    };
  }

  async geocode(query, options = {}) {
    assertNotCancelled(options.signal);
    const cacheKey = comparable(query);
    const cached = this.geocodingCache.get(cacheKey);
    if (cached) return { ...cached };

    const local = localKoreanLocation(query);
    if (local) {
      this.geocodingCache.set(cacheKey, local);
      return { ...local };
    }

    let nominatimError = null;
    if (/[가-힣]/u.test(query)) {
      try {
        const place = await this.geocodeKoreanLocation(query, options);
        this.geocodingCache.set(cacheKey, place);
        return { ...place };
      } catch (error) {
        assertNotCancelled(options.signal);
        nominatimError = error;
      }
    }

    try {
      const place = await this.geocodeOpenMeteo(query, options);
      this.geocodingCache.set(cacheKey, place);
      return { ...place };
    } catch (error) {
      if (error?.code === 'B_WEATHER_LOCATION_NOT_FOUND' && nominatimError?.code?.startsWith?.('B_WEATHER_')) {
        throw nominatimError;
      }
      throw error;
    }
  }

  async geocodeOpenMeteo(query, options = {}) {
    const url = new URL(GEOCODING_ENDPOINT);
    url.search = new URLSearchParams({
      name: query,
      count: '5',
      language: 'ko',
      format: 'json'
    }).toString();
    const payload = await this.fetchJson(url, 'geocoding', options);
    const candidates = Array.isArray(payload?.results) ? payload.results : [];
    const selected = rankGeocodingCandidates(query, candidates)[0];
    if (!selected) {
      throw weatherError('B_WEATHER_LOCATION_NOT_FOUND', `"${query}" 지역을 찾지 못했습니다.`);
    }
    const latitude = finiteNumber(selected.latitude);
    const longitude = finiteNumber(selected.longitude);
    if (latitude === null || longitude === null) {
      throw weatherError('B_WEATHER_GEOCODING_INVALID', '지역 좌표 응답이 올바르지 않습니다.');
    }
    const displayName = uniqueText([
      selected.name,
      selected.admin2,
      selected.admin1,
      selected.country
    ]).join(', ');
    return {
      name: cleanText(selected.name, 120) ?? query,
      displayName: displayName || query,
      latitude,
      longitude,
      countryCode: cleanText(selected.country_code, 8),
      country: cleanText(selected.country, 120),
      admin1: cleanText(selected.admin1, 120),
      admin2: cleanText(selected.admin2, 120),
      timezone: cleanText(selected.timezone, 120),
      sourceUrl: url.toString(),
      geocodingProvider: 'Open-Meteo Geocoding',
      attribution: null
    };
  }

  async geocodeKoreanLocation(query, options = {}) {
    const url = new URL(this.nominatimEndpoint);
    url.search = new URLSearchParams({
      q: buildNominatimQuery(query),
      format: 'jsonv2',
      limit: '5',
      countrycodes: 'kr',
      'accept-language': 'ko',
      addressdetails: '1'
    }).toString();
    await this.reserveNominatimRequest(options);
    const payload = await this.fetchJson(url, '한국 지역 검색', {
      signal: options.signal,
      headers: {
        'user-agent': 'JARVIS-Local-Assistant/1.0 (personal weather report geocoder)'
      }
    });
    const candidates = Array.isArray(payload) ? payload : [];
    const selected = rankNominatimCandidates(query, candidates)[0];
    if (!selected) {
      throw weatherError('B_WEATHER_LOCATION_NOT_FOUND', `"${query}" 지역을 찾지 못했습니다.`);
    }
    const latitude = finiteNumber(selected.lat);
    const longitude = finiteNumber(selected.lon);
    if (latitude === null || longitude === null) {
      throw weatherError('B_WEATHER_GEOCODING_INVALID', '한국 지역 좌표 응답이 올바르지 않습니다.');
    }
    const address = selected.address ?? {};
    const name = cleanText(
      selected.name ?? address.borough ?? address.city_district ?? address.city ?? address.county,
      120
    ) ?? query;
    return {
      name,
      displayName: cleanText(selected.display_name, 240) ?? query,
      latitude,
      longitude,
      countryCode: cleanText(address.country_code, 8)?.toUpperCase() ?? 'KR',
      country: cleanText(address.country, 120) ?? '대한민국',
      admin1: cleanText(address.province ?? address.state ?? address.city, 120),
      admin2: cleanText(address.city_district ?? address.borough ?? address.county, 120),
      timezone: 'Asia/Seoul',
      sourceUrl: url.toString(),
      geocodingProvider: 'OpenStreetMap Nominatim',
      attribution: '© OpenStreetMap contributors'
    };
  }

  async reserveNominatimRequest(options = {}) {
    assertNotCancelled(options.signal);
    const previous = this.nominatimSchedule;
    let release;
    this.nominatimSchedule = new Promise((resolve) => { release = resolve; });
    try { await waitForReservation(previous,options.signal); }
    catch(error){previous.then(release,release);throw error;}
    try {
      const waitMs = Math.max(0, this.lastNominatimRequestAt + NOMINATIM_MIN_INTERVAL_MS - Date.now());
      assertNotCancelled(options.signal);
      if (waitMs > 0) await delay(waitMs, options.signal);
      assertNotCancelled(options.signal);
      this.lastNominatimRequestAt = Date.now();
    } finally {
      release();
    }
  }

  async forecast(place, options = {}) {
    const url = new URL(FORECAST_ENDPOINT);
    url.search = new URLSearchParams({
      latitude: String(place.latitude),
      longitude: String(place.longitude),
      daily: DAILY_FIELDS.join(','),
      timezone: 'auto',
      forecast_days: '7'
    }).toString();
    const payload = await this.fetchJson(url, 'forecast', options);
    const daily = payload?.daily;
    const dates = Array.isArray(daily?.time) ? daily.time : [];
    if (dates.length < 1 || dates.length > 7) {
      throw weatherError('B_WEATHER_FORECAST_INVALID', '7일 예보의 날짜 배열이 올바르지 않습니다.');
    }
    const arrays = Object.fromEntries(DAILY_FIELDS.map((field) => [
      field,
      Array.isArray(daily?.[field]) ? daily[field] : []
    ]));
    for (const [field, values] of Object.entries(arrays)) {
      if (values.length !== dates.length) {
        throw weatherError('B_WEATHER_FORECAST_INVALID', `예보 필드 길이가 일치하지 않습니다: ${field}`);
      }
    }
    const days = dates.map((date, index) => normalizeForecastDay({ date, index, arrays }));
    return {
      timezone: cleanText(payload?.timezone, 120) ?? place.timezone ?? 'auto',
      timezoneAbbreviation: cleanText(payload?.timezone_abbreviation, 24),
      units: {
        temperature: cleanText(payload?.daily_units?.temperature_2m_max, 16) ?? '°C',
        precipitationProbability: cleanText(payload?.daily_units?.precipitation_probability_max, 16) ?? '%',
        precipitation: cleanText(payload?.daily_units?.precipitation_sum, 16) ?? 'mm',
        windSpeed: cleanText(payload?.daily_units?.wind_speed_10m_max, 16) ?? 'km/h'
      },
      days,
      sourceUrl: url.toString()
    };
  }

  async fetchJson(url, phase, { headers = {}, signal } = {}) {
    assertNotCancelled(signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, {once:true});
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json', ...headers },
        redirect: 'error',
        signal: controller.signal
      });
      if (!response?.ok) {
        throw weatherError('B_WEATHER_UPSTREAM_HTTP_ERROR', `날씨 ${phase} 요청이 실패했습니다. (${response?.status ?? 'unknown'})`);
      }
      const text = await readBoundedWeatherText(response,controller);
      assertNotCancelled(signal);
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
        throw weatherError('B_WEATHER_UPSTREAM_RESPONSE_TOO_LARGE', '날씨 응답이 허용 크기를 초과했습니다.');
      }
      try {
        return JSON.parse(text);
      } catch {
        throw weatherError('B_WEATHER_UPSTREAM_JSON_INVALID', '날씨 응답 JSON이 올바르지 않습니다.');
      }
    } catch (error) {
      assertNotCancelled(signal);
      if (error?.name === 'AbortError') {
        throw weatherError('B_WEATHER_UPSTREAM_TIMEOUT', `날씨 ${phase} 요청 시간이 초과되었습니다.`);
      }
      if (error?.code?.startsWith?.('B_WEATHER_')) throw error;
      throw weatherError('B_WEATHER_UPSTREAM_UNAVAILABLE', `날씨 ${phase} 서비스에 연결하지 못했습니다.`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
}

async function readBoundedWeatherText(response,controller){
  const reader=response.body?.getReader?.();
  if(!reader){
    // Legacy test transports without a stream retain the same post-read bound.
    const text=await response.text();
    if(Buffer.byteLength(text,'utf8')>MAX_RESPONSE_BYTES)throw weatherError('B_WEATHER_UPSTREAM_RESPONSE_TOO_LARGE','날씨 응답이 허용 크기를 초과했습니다.');
    return text;
  }
  let size=0,done=false;const chunks=[];
  try{
    while(true){
      const item=await reader.read();
      if(item.done){done=true;break;}
      const chunk=item.value;
      size+=chunk.byteLength;
      if(size>MAX_RESPONSE_BYTES){controller.abort();throw weatherError('B_WEATHER_UPSTREAM_RESPONSE_TOO_LARGE','날씨 응답이 허용 크기를 초과했습니다.');}
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks,size).toString('utf8');
  }finally{
    if(!done)await reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}

export function buildWeeklyWeatherHwpDocument(report) {
  const days = Array.isArray(report?.days) ? report.days : [];
  if (days.length === 0) throw weatherError('B_WEATHER_REPORT_EMPTY', '문서에 넣을 날씨 데이터가 없습니다.');
  const stats = report.statistics ?? calculateWeatherStatistics(days);
  const location = report.location?.displayName ?? report.query ?? '선택 지역';
  const period = `${formatKoreanDate(days[0].date)} - ${formatKoreanDate(days.at(-1).date)}`;
  const rows = days.map((day) => [
    formatKoreanDate(day.date, { includeYear: false }),
    `${day.weekday}요일`,
    day.weatherLabel,
    formatNumber(day.temperatureMin, 1, '°C'),
    formatNumber(day.temperatureMax, 1, '°C'),
    formatNumber(day.precipitationProbabilityMax, 0, '%'),
    formatNumber(day.precipitationSum, 1, ' mm'),
    formatNumber(day.windSpeedMax, 1, ' km/h')
  ]);
  return {
    title: `${location} 향후 7일 날씨 통계`,
    blocks: [
      {
        type: 'paragraph',
        text: `예보 기간: ${period}  |  기준 시간대: ${report.timezone ?? '현지 시간'}`
      },
      { type: 'heading', level: 1, text: '한눈에 보는 주간 통계' },
      {
        type: 'bullets',
        items: [
          `평균 최고 / 최저 기온: ${formatNumber(stats.averageHigh, 1, '°C')} / ${formatNumber(stats.averageLow, 1, '°C')}`,
          `주간 최고 / 최저 기온: ${formatNumber(stats.highestTemperature, 1, '°C')} / ${formatNumber(stats.lowestTemperature, 1, '°C')}`,
          `예상 누적 강수량: ${formatNumber(stats.totalPrecipitation, 1, ' mm')} · 비 예보일 ${stats.rainyDayCount}일`,
          `최대 강수확률: ${formatNumber(stats.maximumPrecipitationProbability, 0, '%')} · 최대 풍속 ${formatNumber(stats.maximumWindSpeed, 1, ' km/h')}`
        ]
      },
      { type: 'heading', level: 1, text: '일자별 예보' },
      {
        type: 'table',
        columns: ['날짜', '요일', '날씨', '최저', '최고', '강수확률', '강수량', '최대풍속'],
        rows
      },
      { type: 'heading', level: 2, text: '출처 및 기준' },
      {
        type: 'paragraph',
        text: weatherSourceLine(report)
      }
    ],
    metadata: {
      reportType: 'weekly-weather-statistics',
      location,
      period,
      sourceUrl: report.source?.forecastUrl ?? null,
      geocodingProvider: report.source?.geocodingProvider ?? null,
      geocodingAttribution: report.source?.geocodingAttribution ?? null,
      retrievedAt: report.source?.retrievedAt ?? null,
      rowCount: rows.length,
      tableCount: 1
    }
  };
}

export function weatherReportFileName(report) {
  const location = sanitizeFileSegment(report?.location?.name ?? report?.query ?? '지역');
  const firstDate = String(report?.days?.[0]?.date ?? new Date().toISOString().slice(0, 10)).replaceAll('-', '');
  return `이번_주_날씨_통계_${location}_${firstDate}.hwp`;
}

export function extractExplicitWeatherLocation(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const marked = text.match(/(?:지역|장소|도시|location)\s*[:：=]\s*["'“”]?([^\]\[;,\n"'“”]{1,80})/iu)?.[1];
  if (marked) return cleanLocationPhrase(marked);
  const administrative = extractKoreanAdministrativePhrase(text);
  if (administrative) return cleanLocationPhrase(administrative);
  const known = WELL_KNOWN_KOREAN_LOCATIONS.find((name) => new RegExp(`(?:^|\\s|["'“”])${name}(?:의|에서|\\s|["'“”]|$)`, 'u').test(text));
  if (known) return known;
  const english = text.match(/(?:location|city|in)\s*[:：=]?\s*([A-Za-z][A-Za-z .'-]{1,60})/i)?.[1];
  return english ? cleanLocationPhrase(english) : null;
}

export function normalizeWeatherLocationAnswer(value) {
  const raw = String(value ?? '').trim();
  const marked = raw.match(/(?:지역|장소|도시|location)\s*[:：=]\s*["'“”]?([^\]\[;,\n"'“”]{1,80})/iu)?.[1];
  if (marked) return cleanLocationPhrase(marked);
  const text = raw
    .trim()
    .replace(/(?:이번\s*주|향후\s*7일|날씨|예보|통계|보고서|문서|표|지역)/gu, ' ')
    .replace(/(?:으로|로|에서|의)(?=\s|$)/gu, ' ')
    .replace(/(?:해\s*줘|해주세요|작성해\s*줘|작성해주세요)$/u, ' ')
    .replace(/["'“”.,!?]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text && text.length <= 80 ? text : null;
}

export function calculateWeatherStatistics(days) {
  const values = Array.isArray(days) ? days : [];
  if (values.length === 0) return {
    averageHigh: null,
    averageLow: null,
    highestTemperature: null,
    lowestTemperature: null,
    totalPrecipitation: 0,
    rainyDayCount: 0,
    maximumPrecipitationProbability: 0,
    maximumWindSpeed: 0
  };
  const highs = values.map((day) => day.temperatureMax).filter(Number.isFinite);
  const lows = values.map((day) => day.temperatureMin).filter(Number.isFinite);
  const precipitation = values.map((day) => day.precipitationSum).filter(Number.isFinite);
  const probabilities = values.map((day) => day.precipitationProbabilityMax).filter(Number.isFinite);
  const winds = values.map((day) => day.windSpeedMax).filter(Number.isFinite);
  return {
    averageHigh: roundOne(average(highs)),
    averageLow: roundOne(average(lows)),
    highestTemperature: roundOne(highs.length ? Math.max(...highs) : null),
    lowestTemperature: roundOne(lows.length ? Math.min(...lows) : null),
    totalPrecipitation: roundOne(precipitation.reduce((sum, number) => sum + number, 0)),
    rainyDayCount: values.filter((day) => Number(day.precipitationSum) >= 0.1 || Number(day.precipitationProbabilityMax) >= 50).length,
    maximumPrecipitationProbability: roundOne(probabilities.length ? Math.max(...probabilities) : 0),
    maximumWindSpeed: roundOne(winds.length ? Math.max(...winds) : 0)
  };
}

function normalizeForecastDay({ date, index, arrays }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    throw weatherError('B_WEATHER_FORECAST_INVALID', `예보 날짜가 올바르지 않습니다: ${date}`);
  }
  const weatherCode = requiredNumber(arrays.weather_code[index], 'weather_code');
  return {
    date: String(date),
    weekday: KOREAN_WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()],
    weatherCode,
    weatherLabel: weatherCodeLabel(weatherCode),
    temperatureMax: requiredNumber(arrays.temperature_2m_max[index], 'temperature_2m_max'),
    temperatureMin: requiredNumber(arrays.temperature_2m_min[index], 'temperature_2m_min'),
    precipitationProbabilityMax: optionalNumber(arrays.precipitation_probability_max[index], 0),
    precipitationSum: optionalNumber(arrays.precipitation_sum[index], 0),
    windSpeedMax: optionalNumber(arrays.wind_speed_10m_max[index], 0),
    sunrise: cleanText(arrays.sunrise[index], 40),
    sunset: cleanText(arrays.sunset[index], 40)
  };
}

function rankGeocodingCandidates(query, candidates) {
  const normalizedQuery = comparable(query);
  return candidates
    .filter((candidate) => candidate && finiteNumber(candidate.latitude) !== null && finiteNumber(candidate.longitude) !== null)
    .map((candidate, index) => {
      const names = [candidate.name, candidate.admin1, candidate.admin2].map(comparable).filter(Boolean);
      let score = Math.max(0, 20 - index);
      if (names.includes(normalizedQuery)) score += 100;
      else if (names.some((name) => name.includes(normalizedQuery) || normalizedQuery.includes(name))) score += 50;
      if (candidate.country_code === 'KR' && /[가-힣]/u.test(query)) score += 10;
      return { ...candidate, _score: score };
    })
    .sort((left, right) => right._score - left._score);
}

function localKoreanLocation(query) {
  const normalized = comparable(query);
  const entry = Object.entries(KOREAN_LOCATION_CENTERS).find(([name]) => comparable(name) === normalized);
  if (!entry) return null;
  const [name, [latitude, longitude, displayName]] = entry;
  return {
    name,
    displayName: `${displayName}, 대한민국`,
    latitude,
    longitude,
    countryCode: 'KR',
    country: '대한민국',
    admin1: displayName,
    admin2: null,
    timezone: 'Asia/Seoul',
    sourceUrl: null,
    geocodingProvider: 'JARVIS 한국 주요 도시 좌표 사전',
    attribution: null
  };
}

function buildNominatimQuery(query) {
  const cleaned = String(query ?? '').replace(/[,]+/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = cleaned.split(' ').filter(Boolean);
  if (tokens.length > 1) return `${tokens.reverse().join(', ')}, 대한민국`;
  return `${cleaned}, 대한민국`;
}

function rankNominatimCandidates(query, candidates) {
  const normalizedQuery = comparable(query);
  const queryTokens = String(query ?? '').split(/\s+/).map(comparable).filter(Boolean);
  return candidates
    .filter((candidate) => candidate && finiteNumber(candidate.lat) !== null && finiteNumber(candidate.lon) !== null)
    .filter((candidate) => !candidate.address?.country_code || String(candidate.address.country_code).toLowerCase() === 'kr')
    .map((candidate, index) => {
      const address = candidate.address ?? {};
      const names = [
        candidate.name,
        candidate.display_name,
        address.city,
        address.city_district,
        address.borough,
        address.county,
        address.state,
        address.province,
        address.suburb,
        address.quarter
      ].map(comparable).filter(Boolean);
      let score = Math.max(0, 30 - index * 2) + Number(candidate.importance ?? 0) * 10;
      if (names.some((name) => name === normalizedQuery)) score += 120;
      score += queryTokens.filter((token) => names.some((name) => name.includes(token) || token.includes(name))).length * 35;
      if (candidate.class === 'boundary' || candidate.class === 'place') score += 30;
      if (candidate.type === 'administrative' || candidate.addresstype === 'administrative') score += 35;
      if (['amenity', 'shop', 'tourism', 'leisure'].includes(candidate.class)) score -= 100;
      return { ...candidate, _score: score };
    })
    .sort((left, right) => right._score - left._score);
}

function extractKoreanAdministrativePhrase(text) {
  const knownPrefix = WELL_KNOWN_KOREAN_LOCATIONS
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const knownWithDistrict = String(text).match(
    new RegExp(`(?:^|\\s)((${knownPrefix})\\s+[가-힣]{1,20}(?:시|군|구|읍|면|동))(?:의|에서|\\s|$)`, 'u')
  )?.[1];
  if (knownWithDistrict) return knownWithDistrict;

  // 읍/면/동은 "화면", "운동" 같은 일반 명사를 쉽게 오인하므로
  // 상위 행정구역이 함께 있는 knownWithDistrict 경로에서만 허용한다.
  // 단독 토큰은 접미사 앞에 최소 두 글자를 요구해 "날씨", "도시"도 제외한다.
  const tokens = [...String(text).matchAll(/[가-힣]{2,20}(?:특별자치도|특별자치시|특별시|광역시|도|시|군|구)/gu)];
  if (tokens.length === 0) return null;
  let phrase = tokens[0][0];
  let end = Number(tokens[0].index) + tokens[0][0].length;
  for (const token of tokens.slice(1, 3)) {
    const gap = String(text).slice(end, Number(token.index));
    if (!/^\s+$/.test(gap)) break;
    phrase += ` ${token[0]}`;
    end = Number(token.index) + token[0].length;
  }
  return phrase;
}

function weatherSourceLine(report) {
  const provider = report.source?.provider ?? 'Open-Meteo';
  const geocoder = report.source?.geocodingProvider;
  const attribution = report.source?.geocodingAttribution;
  const positionSource = geocoder ? ` | 위치 기준: ${geocoder}${attribution ? ` (${attribution})` : ''}` : '';
  return `출처: ${provider}${positionSource} | 조회 시점: ${formatKoreanDateTime(report.source?.retrievedAt)} | 예보는 실제 관측과 달라질 수 있습니다.`;
}

function weatherCodeLabel(code) {
  if (code === 0) return '맑음';
  if ([1, 2].includes(code)) return '대체로 맑음';
  if (code === 3) return '흐림';
  if ([45, 48].includes(code)) return '안개';
  if ([51, 53, 55, 56, 57].includes(code)) return '이슬비';
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return '비';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return '눈';
  if ([95, 96, 99].includes(code)) return '뇌우';
  return `날씨 코드 ${code}`;
}

function formatKoreanDate(value, { includeYear = true } = {}) {
  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return String(value ?? '');
  return includeYear
    ? `${Number(match[1])}년 ${Number(match[2])}월 ${Number(match[3])}일`
    : `${Number(match[2])}/${Number(match[3])}`;
}

function formatKoreanDateTime(value) {
  const date = new Date(value ?? '');
  if (Number.isNaN(date.getTime())) return String(value ?? '확인 불가');
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

function formatNumber(value, digits, suffix) {
  return Number.isFinite(value) ? `${Number(value).toFixed(digits)}${suffix}` : '-';
}

function average(values) {
  return values.length ? values.reduce((sum, number) => sum + number, 0) / values.length : null;
}

function roundOne(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

function requiredNumber(value, field) {
  const number = finiteNumber(value);
  if (number === null) throw weatherError('B_WEATHER_FORECAST_INVALID', `예보 숫자 필드가 올바르지 않습니다: ${field}`);
  return number;
}

function optionalNumber(value, fallback) {
  return finiteNumber(value) ?? fallback;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanLocationPhrase(value) {
  const text = String(value ?? '')
    .trim()
    .replace(/(?:이번\s*주|향후\s*7일|날씨|예보|통계|보고서|문서|표).*$/u, '')
    .replace(/(?:에서|의)$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, 80) : null;
}

function normalizeLocation(value) {
  return cleanLocationPhrase(value);
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

function uniqueText(values) {
  return [...new Set(values.map((value) => cleanText(value, 120)).filter(Boolean))];
}

function comparable(value) {
  return String(value ?? '').toLocaleLowerCase('ko-KR').replace(/[\s,.-]+/g, '');
}

function sanitizeFileSegment(value) {
  const text = String(value ?? '지역')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return text || '지역';
}

function weatherError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function normalizeGeocodingEndpoint(value) {
  let url;
  try {
    url = new URL(String(value || NOMINATIM_ENDPOINT));
  } catch {
    throw new TypeError('JARVIS_GEOCODING_API_URL must be a valid URL.');
  }
  const local = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new TypeError('Geocoding endpoint must use HTTPS or a local HTTP address.');
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}

function assertNotCancelled(signal) {
  if(signal?.aborted)throw weatherError('B_OPERATION_CANCELLED','날씨 조회 작업이 취소되었습니다.');
}
function waitForReservation(previous,signal){
  assertNotCancelled(signal);
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal?.removeEventListener('abort',abort);reject(weatherError('B_OPERATION_CANCELLED','날씨 조회 작업이 취소되었습니다.'));};
    signal?.addEventListener('abort',abort,{once:true});
    previous.then(()=>{signal?.removeEventListener('abort',abort);resolve();},error=>{signal?.removeEventListener('abort',abort);reject(error);});
  });
}
function delay(milliseconds,signal) {
  assertNotCancelled(signal);
  return new Promise((resolve,reject) => {
    const cleanup=()=>signal?.removeEventListener('abort',abort);
    const timer=setTimeout(()=>{cleanup();resolve();},milliseconds);
    const abort=()=>{clearTimeout(timer);cleanup();reject(weatherError('B_OPERATION_CANCELLED','날씨 조회 작업이 취소되었습니다.'));};
    signal?.addEventListener('abort',abort,{once:true});
  });
}
