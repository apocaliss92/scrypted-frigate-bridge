import { HttpRequest, HttpResponse } from '@scrypted/sdk';
import http from 'http';
import https from 'https';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { maskForLog } from './utils';

type TranscodedCacheEntry = {
    key: string;
    sourceFilePath?: string;
    vodUsable?: boolean;
    vodLastCheckedAt?: number;
    vodPlaylistText?: string;
    vodPlaylistFetchedAt?: number;
    inFlightVodPlaylist?: Promise<string>;
    createdAt?: number;
    lastAccessAt?: number;
    inFlightSource?: Promise<string>;
    cleanupTimer?: NodeJS.Timeout;
};

// iOS clients often issue multiple Range requests for the same clip.
// Cache the transcoded MP4 on disk briefly to avoid re-transcoding per request.
const TRANSCODE_CACHE_TTL_MS = 2 * 60 * 1000;
const transcodedCache = new Map<string, TranscodedCacheEntry>();

const httpKeepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const httpsKeepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

const getKeepAliveAgent = (url: string) => {
    try {
        return new URL(url).protocol === 'https:' ? httpsKeepAliveAgent : httpKeepAliveAgent;
    } catch {
        return httpKeepAliveAgent;
    }
};

const scheduleCacheCleanup = (entry: TranscodedCacheEntry, logger: Console) => {
    if (entry.cleanupTimer) {
        try {
            clearTimeout(entry.cleanupTimer);
        } catch {
        }
    }

    entry.cleanupTimer = setTimeout(async () => {
        const current = transcodedCache.get(entry.key);
        if (!current)
            return;

        const lastAccessAt = current.lastAccessAt ?? current.createdAt ?? Date.now();
        if (Date.now() - lastAccessAt < TRANSCODE_CACHE_TTL_MS) {
            scheduleCacheCleanup(current, logger);
            return;
        }

        transcodedCache.delete(entry.key);
        const files = [current.sourceFilePath].filter(Boolean) as string[];
        for (const filePath of files) {
            try {
                await fs.promises.unlink(filePath);
                logger.log('Videoclip: deleted cached file', {
                    filePath,
                });
            } catch {
            }
        }
    }, TRANSCODE_CACHE_TTL_MS);
};

function getHttpModule(url: string) {
    try {
        return new URL(url).protocol === 'https:' ? https : http;
    } catch {
        return http;
    }
}

const downloadUrlToFile = async (options: {
    url: string;
    headers: Record<string, any> | undefined;
    filePath: string;
    logger: Console;
}): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
        const mod = getHttpModule(options.url);
        const req = mod.get(options.url, { headers: options.headers, agent: getKeepAliveAgent(options.url) }, (httpResponse) => {
            const statusCode = httpResponse.statusCode ?? 0;
            options.logger.log('Videoclip upstream response (download)', {
                statusCode,
                contentType: httpResponse.headers?.['content-type'],
                contentLength: httpResponse.headers?.['content-length'],
            });

            if (statusCode >= 400) {
                reject(new Error(`Error downloading video: ${statusCode} - ${httpResponse.statusMessage}`));
                try {
                    httpResponse.resume();
                } catch {
                }
                return;
            }

            const out = fs.createWriteStream(options.filePath);
            const cleanup = async () => {
                try {
                    out.close();
                } catch {
                }
                try {
                    await fs.promises.unlink(options.filePath);
                } catch {
                }
            };

            out.on('error', async (e) => {
                options.logger.log('Videoclip: error writing download file', e);
                await cleanup();
                reject(e);
            });

            httpResponse.on('error', async (e) => {
                options.logger.log('Videoclip: error reading download stream', e);
                await cleanup();
                reject(e);
            });

            out.on('finish', () => {
                resolve();
            });

            httpResponse.pipe(out);
        });

        req.on('error', async (e) => {
            options.logger.log('Videoclip: error downloading video', e);
            try {
                await fs.promises.unlink(options.filePath);
            } catch {
            }
            reject(e);
        });
    });
};

const sanitizeGenericProxyHeaders = (headers: Record<string, any> | undefined) => {
    if (!headers)
        return headers;

    const h: Record<string, any> = { ...headers };

    delete h['connection'];
    delete h['Connection'];
    delete h['keep-alive'];
    delete h['Keep-Alive'];
    delete h['proxy-connection'];
    delete h['Proxy-Connection'];
    delete h['transfer-encoding'];
    delete h['Transfer-Encoding'];
    delete h['upgrade'];
    delete h['Upgrade'];

    return h;
};

const stripHostHeader = (headers: Record<string, any> | undefined) => {
    if (!headers)
        return headers;
    const cloned: Record<string, any> = { ...headers };
    delete cloned['host'];
    delete cloned['Host'];
    return cloned;
};

const encodeHlsProxyPath = (options: {
    requestUrl: URL;
    deviceId: string;
    eventId: string;
    targetUrl: string;
}): string => {
    const u = new URL(options.requestUrl.toString());
    u.searchParams.set('deviceId', options.deviceId);
    u.searchParams.set('eventId', options.eventId);
    u.searchParams.set('hls', 'seg');
    u.searchParams.set('u', options.targetUrl);
    return u.pathname + '?' + u.searchParams.toString();
};

const isAllowedProxyTarget = (target: string, allowedOrigins: string[]): boolean => {
    try {
        const u = new URL(target);
        if (u.protocol !== 'http:' && u.protocol !== 'https:')
            return false;
        return allowedOrigins.includes(u.origin);
    } catch {
        return false;
    }
};

const proxyUrlStream = async (options: {
    url: string;
    request: HttpRequest;
    response: HttpResponse;
    logger: Console;
}): Promise<void> => {
    const upstreamHeaders = stripHostHeader(options.request.headers as any);
    const mod = getHttpModule(options.url);

    return new Promise<void>((resolve, reject) => {
        const req = mod.get(options.url, { headers: upstreamHeaders, agent: getKeepAliveAgent(options.url) }, (httpResponse) => {
            const statusCode = httpResponse.statusCode ?? 0;

            if (statusCode >= 400) {
                reject(new Error(`Error proxying url: ${statusCode} - ${httpResponse.statusMessage}`));
                try {
                    httpResponse.resume();
                } catch {
                }
                return;
            }

            try {
                options.response.sendStream((async function* () {
                    for await (const chunk of httpResponse) {
                        yield chunk;
                    }
                })(), {
                    code: httpResponse.statusCode,
                    headers: sanitizeGenericProxyHeaders(httpResponse.headers as any),
                });
                resolve();
            } catch (err) {
                reject(err);
            }
        });

        req.on('error', (e) => {
            options.logger.log('Error proxying url', e);
            reject(e);
        });
    });
};

const fetchVodHlsPlaylistText = async (options: {
    request: HttpRequest;
    logger: Console;
    vodUrl: string;
}): Promise<string> => {
    const { vodUrl, logger } = options;
    const mod = getHttpModule(vodUrl);

    return new Promise<string>((resolve, reject) => {
        const baseHeaders: Record<string, any> = {
            ...(stripHostHeader(options.request.headers as any) ?? {}),
        };
        delete baseHeaders['accept-encoding'];
        delete baseHeaders['Accept-Encoding'];
        // Prevent compressed m3u8 bodies, since we stream as plain text.
        baseHeaders['Accept-Encoding'] = 'identity';

        const req = mod.get(vodUrl, { headers: baseHeaders, agent: getKeepAliveAgent(vodUrl) }, (res) => {
            const statusCode = res.statusCode ?? 0;
            const contentType = res.headers?.['content-type'];
            const contentEncoding = res.headers?.['content-encoding'];
            if (statusCode >= 400) {
                reject(new Error(`Error loading VOD playlist: ${statusCode} - ${res.statusMessage}`));
                try {
                    res.resume();
                } catch {
                }
                return;
            }
            const chunks: Buffer[] = [];
            res.on('data', (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
            res.on('end', () => {
                try {
                    let body: Buffer = Buffer.concat(chunks) as Buffer;
                    if (typeof contentEncoding === 'string') {
                        const ce = contentEncoding.toLowerCase();
                        if (ce.includes('gzip'))
                            body = zlib.gunzipSync(body) as Buffer;
                        else if (ce.includes('br'))
                            body = zlib.brotliDecompressSync(body) as Buffer;
                        else if (ce.includes('deflate'))
                            body = zlib.inflateSync(body) as Buffer;
                    }
                    const text = body.toString('utf8');
                    logger.log('Videoclip: VOD playlist response', {
                        statusCode,
                        contentType,
                        contentEncoding,
                        prefix: text.slice(0, 64),
                    });
                    resolve(text);
                } catch (e) {
                    reject(e);
                }
            });
            res.on('error', reject);
        });
        req.on('error', reject);
    });
};

const sendVodHlsPlaylistFromText = async (options: {
    requestUrl: URL;
    response: HttpResponse;
    logger: Console;
    deviceId: string;
    eventId: string;
    vodUrl: string;
    playlistText: string;
}): Promise<boolean> => {
    const { vodUrl, logger, requestUrl, deviceId, eventId, playlistText } = options;

    const normalized = playlistText.replace(/^\uFEFF/, '');
    if (!normalized.trim().startsWith('#EXTM3U')) {
        logger.log('Videoclip: VOD playlist did not look like m3u8');
        return false;
    }

    const rewritten = normalized
        .split('\n')
        .map((line) => {
            const trimmed = line.trim();
            if (!trimmed)
                return line;

            if (trimmed.startsWith('#EXT-X-MAP:') || trimmed.startsWith('#EXT-X-KEY:')) {
                const m = trimmed.match(/URI="([^"]+)"/);
                if (!m)
                    return line;
                const abs = new URL(m[1], vodUrl).href;
                const proxied = encodeHlsProxyPath({ requestUrl, deviceId, eventId, targetUrl: abs });
                return line.replace(m[1], proxied);
            }

            if (trimmed.startsWith('#'))
                return line;

            const abs = new URL(trimmed, vodUrl).href;
            return encodeHlsProxyPath({ requestUrl, deviceId, eventId, targetUrl: abs });
        })
        .join('\n');

    options.response.send(rewritten, {
        headers: {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Cache-Control': 'no-cache',
        }
    });

    return true;
};

export type VideoclipClientInfo = {
    userAgent?: string;
    accept?: string;
    range?: string;
    secChUa?: string;
    secChUaMobile?: string;
    secChUaPlatform?: string;
};

const getHeader = (headers: Record<string, any> | undefined, key: string) => {
    return headers?.[key] ?? headers?.[key.toLowerCase()] ?? headers?.[key.toUpperCase()];
};

export const getVideoclipClientInfo = (request: HttpRequest): VideoclipClientInfo => {
    return {
        userAgent: getHeader(request.headers, 'user-agent') ?? getHeader(request.headers, 'User-Agent'),
        accept: getHeader(request.headers, 'accept') ?? getHeader(request.headers, 'Accept'),
        range: getHeader(request.headers, 'range') ?? getHeader(request.headers, 'Range'),
        secChUa: getHeader(request.headers, 'sec-ch-ua') ?? getHeader(request.headers, 'Sec-CH-UA'),
        secChUaMobile: getHeader(request.headers, 'sec-ch-ua-mobile') ?? getHeader(request.headers, 'Sec-CH-UA-Mobile'),
        secChUaPlatform: getHeader(request.headers, 'sec-ch-ua-platform') ?? getHeader(request.headers, 'Sec-CH-UA-Platform'),
    };
};

export type VideoclipMode = 'default' | 'mp4' | 'vod-hls';

export type VideoclipModeDecision = {
    mode: VideoclipMode;
    source: 'setting' | 'default';
    clientInfo: VideoclipClientInfo;
};

const normalizeVideoclipModeSetting = (raw: string | undefined): VideoclipMode => {
    const v = (raw ?? 'Default').toString().trim().toLowerCase();
    if (v === 'mp4')
        return 'mp4';
    if (v === 'vod-hls' || v === 'vod' || v === 'hls')
        return 'vod-hls';
    return 'default';
};

export const decideVideoclipMode = (
    requestUrl: URL,
    request: HttpRequest,
    videoclipModeSetting?: string,
): VideoclipModeDecision => {
    const clientInfo = getVideoclipClientInfo(request);

    const settingMode = normalizeVideoclipModeSetting(videoclipModeSetting);
    if (settingMode !== 'default')
        return { mode: settingMode, source: 'setting', clientInfo };

    const ua = (clientInfo.userAgent ?? '').toLowerCase();
    const isIos = /iphone|ipad|ipod/.test(ua);
    const isIosInstalledApp = ua.includes('installedapp');

    // Default behavior: iOS InstalledApp => VOD/HLS, others => MP4.
    return { mode: (isIos && isIosInstalledApp) ? 'vod-hls' : 'mp4', source: 'default', clientInfo };
};

const sanitizeProxyHeaders = (headers: Record<string, any> | undefined) => {
    if (!headers)
        return headers;

    const h: Record<string, any> = { ...headers };

    // Remove hop-by-hop headers that can confuse downstream clients.
    delete h['connection'];
    delete h['Connection'];
    delete h['keep-alive'];
    delete h['Keep-Alive'];
    delete h['proxy-connection'];
    delete h['Proxy-Connection'];
    delete h['transfer-encoding'];
    delete h['Transfer-Encoding'];
    delete h['upgrade'];
    delete h['Upgrade'];

    // Ensure we have a sane content type.
    if (!h['content-type'] && !h['Content-Type'])
        h['Content-Type'] = 'video/mp4';

    return h;
};

const parseSingleRange = (rangeHeader: string | undefined, size: number): { start: number; end: number } | undefined => {
    if (!rangeHeader)
        return;

    const m = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
    if (!m)
        return;

    const startStr = m[1];
    const endStr = m[2];

    // bytes=-N (suffix)
    if (!startStr && endStr) {
        const suffixLength = Number.parseInt(endStr, 10);
        if (!Number.isFinite(suffixLength) || suffixLength <= 0)
            return;
        const start = Math.max(0, size - suffixLength);
        const end = size - 1;
        return { start, end };
    }

    const start = Number.parseInt(startStr, 10);
    const end = endStr ? Number.parseInt(endStr, 10) : (size - 1);

    if (!Number.isFinite(start) || !Number.isFinite(end))
        return;
    if (start < 0 || end < 0 || start > end)
        return;
    if (start >= size)
        return;

    return { start, end: Math.min(end, size - 1) };
};

const streamFileWithOptionalRange = async (options: {
    filePath: string;
    request: HttpRequest;
    response: HttpResponse;
    logger: Console;
    deleteAfterServe?: boolean;
}): Promise<void> => {
    const stat = await fs.promises.stat(options.filePath);
    const size = stat.size;
    const rangeHeader = getHeader(options.request.headers as any, 'range') ?? getHeader(options.request.headers as any, 'Range');
    const parsed = parseSingleRange(rangeHeader, size);

    const start = parsed?.start ?? 0;
    const end = parsed?.end ?? (size - 1);
    const isPartial = !!parsed;

    const headers: Record<string, any> = {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
    };

    if (isPartial) {
        headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }

    options.logger.log('Videoclip: serving file', {
        size,
        range: rangeHeader,
        start,
        end,
        partial: isPartial,
    });

    const readStream = fs.createReadStream(options.filePath, { start, end });

    options.response.sendStream((async function* () {
        try {
            for await (const chunk of readStream) {
                yield chunk as Buffer;
            }
        } finally {
            try {
                readStream.destroy();
            } catch {
            }
            if (options.deleteAfterServe) {
                try {
                    await fs.promises.unlink(options.filePath);
                } catch {
                }
            }
        }
    })(), {
        code: isPartial ? 206 : 200,
        headers,
    });
};

export type StreamVideoclipOptions = {
    requestUrl: URL;
    request: HttpRequest;
    response: HttpResponse;
    videoUrl: string;
    vodUrl?: string;
    videoclipMode?: string;
    logger: Console;
    deviceId: string;
    eventId: string;
};

const stripRangeHeaders = (headers: Record<string, any> | undefined) => {
    if (!headers)
        return headers;

    // iOS/WKWebView often probes with Range: bytes=0-1.
    // If we forward it upstream, Frigate returns only 2 bytes (206), and playback fails.
    const cloned: Record<string, any> = { ...headers };
    delete cloned['range'];
    delete cloned['Range'];
    return cloned;
};

const streamDirect = async (options: StreamVideoclipOptions) => {
    const { request, response, videoUrl, logger } = options;

    const upstreamHeaders = request.headers as any;

    return new Promise<void>((resolve, reject) => {
        const mod = getHttpModule(videoUrl);
        mod.get(videoUrl, { headers: upstreamHeaders, agent: getKeepAliveAgent(videoUrl) }, (httpResponse) => {
            const statusCode = httpResponse.statusCode ?? 0;

            logger.log('Videoclip upstream response (direct)', {
                statusCode,
                contentType: httpResponse.headers?.['content-type'],
                contentLength: httpResponse.headers?.['content-length'],
                acceptRanges: httpResponse.headers?.['accept-ranges'],
                contentRange: httpResponse.headers?.['content-range'],
            });

            if (statusCode >= 400) {
                reject(new Error(`Error loading the video: ${statusCode} - ${httpResponse.statusMessage}. Headers: ${JSON.stringify(request.headers)}`));
                try {
                    httpResponse.resume();
                } catch {
                }
                return;
            }

            try {
                response.sendStream((async function* () {
                    for await (const chunk of httpResponse) {
                        yield chunk;
                    }
                })(), {
                    code: httpResponse.statusCode,
                    headers: sanitizeProxyHeaders(httpResponse.headers as any),
                });

                resolve();
            } catch (err) {
                reject(err);
            }
        }).on('error', (e) => {
            logger.log('Error fetching videoclip (direct)', e);
            reject(e);
        });
    });
};

const getCacheEntry = (cacheKey: string): TranscodedCacheEntry => {
    let entry = transcodedCache.get(cacheKey);
    if (!entry) {
        entry = { key: cacheKey };
        transcodedCache.set(cacheKey, entry);
    }
    return entry;
};

const tryServeVodHls = async (options: StreamVideoclipOptions, cacheKey: string, entry: TranscodedCacheEntry): Promise<boolean> => {
    const { request, response, logger, vodUrl } = options;
    if (!vodUrl)
        return false;

    const now = Date.now();
    const lastChecked = entry.vodLastCheckedAt ?? 0;

    // If VOD was recently determined unusable, don't re-check on every request.
    if (entry.vodUsable === false && now - lastChecked < 60_000) {
        logger.log('Videoclip: skipping VOD (recently unusable)', { cacheKey });
        return false;
    }

    const vodWindowMs = 5 * 60_000;

    // If VOD was usable recently and we cached the playlist body, serve without refetching.
    if (
        entry.vodUsable === true
        && now - lastChecked < vodWindowMs
        && entry.vodPlaylistText
        && (!entry.vodPlaylistFetchedAt || now - entry.vodPlaylistFetchedAt < vodWindowMs)
    ) {
        logger.log('Videoclip: serving cached VOD playlist text', { cacheKey });
        const ok = await sendVodHlsPlaylistFromText({
            requestUrl: options.requestUrl,
            response,
            logger,
            deviceId: options.deviceId,
            eventId: options.eventId,
            vodUrl,
            playlistText: entry.vodPlaylistText,
        });
        entry.vodLastCheckedAt = now;
        entry.vodUsable = ok;
        if (!ok) {
            entry.vodPlaylistText = undefined;
            entry.vodPlaylistFetchedAt = undefined;
        }
        return ok;
    }

    try {
        logger.log('Videoclip: trying VOD HLS playlist', { vodUrl: maskForLog(vodUrl) });

        if (!entry.inFlightVodPlaylist) {
            entry.inFlightVodPlaylist = fetchVodHlsPlaylistText({
                request,
                logger,
                vodUrl,
            });
        }

        let playlistText: string;
        try {
            playlistText = await entry.inFlightVodPlaylist;
        } finally {
            entry.inFlightVodPlaylist = undefined;
        }

        entry.vodPlaylistText = playlistText;
        entry.vodPlaylistFetchedAt = Date.now();

        const ok = await sendVodHlsPlaylistFromText({
            requestUrl: options.requestUrl,
            response,
            logger,
            deviceId: options.deviceId,
            eventId: options.eventId,
            vodUrl,
            playlistText,
        });
        entry.vodLastCheckedAt = now;
        entry.vodUsable = ok;
        if (!ok) {
            entry.vodPlaylistText = undefined;
            entry.vodPlaylistFetchedAt = undefined;
        }
        return ok;
    } catch (e) {
        entry.vodLastCheckedAt = now;
        entry.vodUsable = false;
        entry.vodPlaylistText = undefined;
        entry.vodPlaylistFetchedAt = undefined;
        entry.inFlightVodPlaylist = undefined;
        logger.log('Videoclip: HLS playlist attempt failed', e);
        return false;
    }
};

const ensureMp4Cached = async (options: StreamVideoclipOptions, cacheKey: string, entry: TranscodedCacheEntry): Promise<void> => {
    const { request, videoUrl, logger } = options;

    entry.lastAccessAt = Date.now();
    scheduleCacheCleanup(entry, logger);

    if (entry.sourceFilePath)
        return;

    if (!entry.inFlightSource) {
        const tmpName = `frigate-videoclip-src-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.mp4`;
        const tmpFilePath = path.join(os.tmpdir(), tmpName);
        entry.inFlightSource = (async () => {
            const upstreamHeaders = stripRangeHeaders(request.headers as any);
            logger.log('Videoclip: downloading clip to cache', { cacheKey, tmpFilePath });
            await downloadUrlToFile({
                url: videoUrl,
                headers: upstreamHeaders,
                filePath: tmpFilePath,
                logger,
            });
            return tmpFilePath;
        })();
    }

    try {
        entry.sourceFilePath = await entry.inFlightSource;
    } finally {
        entry.inFlightSource = undefined;
    }

    entry.createdAt = entry.createdAt ?? Date.now();
    entry.lastAccessAt = Date.now();
    scheduleCacheCleanup(entry, logger);
};

const serveMp4CachedWithRange = async (options: StreamVideoclipOptions, cacheKey: string, entry: TranscodedCacheEntry): Promise<void> => {
    await ensureMp4Cached(options, cacheKey, entry);
    options.logger.log('Videoclip: serving cached mp4 file', { cacheKey, filePath: entry.sourceFilePath });
    return streamFileWithOptionalRange({
        filePath: entry.sourceFilePath!,
        request: options.request,
        response: options.response,
        logger: options.logger,
        deleteAfterServe: false,
    });
};

export const streamVideoclipFromUrl = async (options: StreamVideoclipOptions): Promise<void> => {
    // HLS segment proxy path (used only when we serve a rewritten m3u8 playlist).
    if ((options.requestUrl.searchParams.get('hls') ?? '').toLowerCase() === 'seg') {
        const target = options.requestUrl.searchParams.get('u');
        if (!target) {
            options.response.send('Missing hls segment url', { code: 400 });
            return;
        }

        options.logger.log('Videoclip: proxying HLS segment', {
            target: maskForLog(target),
        });

        const allowedOrigins = [new URL(options.videoUrl).origin];
        if (options.vodUrl)
            allowedOrigins.push(new URL(options.vodUrl).origin);

        if (!isAllowedProxyTarget(target, allowedOrigins)) {
            options.response.send('Invalid hls segment url', { code: 400 });
            return;
        }

        return proxyUrlStream({
            url: target,
            request: options.request,
            response: options.response,
            logger: options.logger,
        });
    }

    const decision = decideVideoclipMode(options.requestUrl, options.request, options.videoclipMode);

    options.logger.log('Videoclip request', {
        eventId: options.eventId,
        deviceId: options.deviceId,
        videoclipModeSetting: options.videoclipMode,
        mode: decision.mode,
        modeSource: decision.source,
        client: decision.clientInfo,
    });

    const cacheKey = `${options.deviceId}:${options.eventId}`;
    const entry = getCacheEntry(cacheKey);
    entry.lastAccessAt = Date.now();
    scheduleCacheCleanup(entry, options.logger);

    const ua = (decision.clientInfo.userAgent ?? '').toLowerCase();
    const isIosInstalledApp = ua.includes('installedapp');
    const hasRange = !!decision.clientInfo.range;

    if (decision.mode === 'vod-hls') {
        options.logger.log(`Fetching videoclip via VOD/HLS from ${maskForLog(options.vodUrl)} (mode=vod-hls)`);
        const ok = await tryServeVodHls(options, cacheKey, entry);
        if (ok)
            return;

        // Forced VOD mode must not fall back to MP4.
        if (decision.source === 'setting') {
            options.response.send('VOD-HLS unavailable for this event', { code: 502 });
            return;
        }

        options.logger.log('Videoclip: VOD-HLS unavailable, falling back to MP4', { cacheKey });
        // fall through to MP4
    }

    options.logger.log(`Fetching videoclip from ${maskForLog(options.videoUrl)} (mode=mp4)`);

    // For iOS InstalledApp and/or Range requests, serve MP4 from cache to guarantee Content-Length + Range.
    if (isIosInstalledApp || hasRange)
        return serveMp4CachedWithRange(options, cacheKey, entry);

    // For other clients, proxy the MP4 directly for lower latency.
    return streamDirect(options);
};
