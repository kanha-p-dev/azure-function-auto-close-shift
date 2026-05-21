import { app, InvocationContext, Timer } from "@azure/functions";
import * as https from "node:https";

const TIMER_NAME = "autoCloseShiftTimer";
const TIMER_SCHEDULE = "*/5 * * * * *";
const RESPONSE_PREVIEW_LIMIT = 240;

let runCount = 0;

class HttpStatusError extends Error {
    constructor(public readonly statusCode: number, public readonly responsePreview: string) {
        super(`API returned non-success status: ${statusCode}`);
        this.name = "HttpStatusError";
    }
}

type AutoCloseShiftConfig = {
    url: string;
    timeoutMs: number;
    concurrency: number;
};

function formatIsoDate(value?: string): string {
    if (!value) {
        return "-";
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function parsePositiveInteger(rawValue: string | undefined, fallback: number, key: string): number {
    if (!rawValue) {
        return fallback;
    }

    const parsed = Number(rawValue);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${key} must be a positive integer. Received: ${rawValue}`);
    }

    return parsed;
}

function getRequiredEnv(key: string): string {
    const value = process.env[key]?.trim();
    if (!value) {
        throw new Error(`${key} is required. Set it in local.settings.json or Function App settings.`);
    }

    return value;
}

function loadAutoCloseShiftConfig(): AutoCloseShiftConfig {
    return {
        url: getRequiredEnv("AUTO_CLOSE_SHIFT_URL"),
        timeoutMs: parsePositiveInteger(process.env.AUTO_CLOSE_SHIFT_TIMEOUT_MS, 15000, "AUTO_CLOSE_SHIFT_TIMEOUT_MS"),
        concurrency: parsePositiveInteger(process.env.AUTO_CLOSE_SHIFT_CONCURRENCY, 5, "AUTO_CLOSE_SHIFT_CONCURRENCY")
    };
}

function buildAutoClosePayload(requestedAt: string, concurrency: number): { triggerSource: string; requestedAt: string; concurrency: number } {
    return {
        triggerSource: "timer",
        requestedAt,
        concurrency
    };
}

function compactText(text: string, maxLength: number): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) {
        return "-";
    }

    if (normalized.length <= maxLength) {
        return normalized;
    }

    return `${normalized.slice(0, maxLength - 3)}...`;
}

function getNgrokHint(responseBody: string): string | undefined {
    if (!responseBody.includes("ERR_NGROK_3200")) {
        return undefined;
    }

    return "Ngrok endpoint offline: start tunnel (ngrok http 7071) and use the latest URL.";
}

async function postJson(url: string, payload: unknown, timeoutMs: number): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(payload);
        const requestUrl = new URL(url);

        const req = https.request(
            {
                protocol: requestUrl.protocol,
                hostname: requestUrl.hostname,
                port: requestUrl.port,
                path: `${requestUrl.pathname}${requestUrl.search}`,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(data)
                }
            },
            (res) => {
                const chunks: Buffer[] = [];

                res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
                res.on("end", () => {
                    const body = Buffer.concat(chunks).toString("utf8");
                    resolve({ statusCode: res.statusCode ?? 0, body });
                });
            }
        );

        req.on("error", reject);
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
        });

        req.write(data);
        req.end();
    });
}

export async function autoCloseShiftTimer(timer: Timer, context: InvocationContext): Promise<void> {
    const config = loadAutoCloseShiftConfig();

    runCount++;

    const now = new Date().toISOString();
    const last = formatIsoDate(timer.scheduleStatus?.last);
    const next = formatIsoDate(timer.scheduleStatus?.next);
    const lastUpdated = formatIsoDate(timer.scheduleStatus?.lastUpdated);
    const isPastDue = timer.isPastDue === true ? "yes" : "no";

    context.log("========================================");
    context.log(`[${TIMER_NAME}]`);
    context.log(`Run: ${runCount}`);
    context.log(`InvocationId: ${context.invocationId}`);
    context.log(`Now: ${now}`);
    context.log(`IsPastDue: ${isPastDue}`);
    context.log(`Schedule Last: ${last}`);
    context.log(`Schedule Next: ${next}`);
    context.log(`Schedule Updated: ${lastUpdated}`);

    const payload = buildAutoClosePayload(now, config.concurrency);

    context.log(`API URL: ${config.url}`);
    context.log(`API Payload: ${JSON.stringify(payload)}`);

    try {
        const result = await postJson(config.url, payload, config.timeoutMs);
        const isSuccess = result.statusCode >= 200 && result.statusCode < 300;
        const responsePreview = compactText(result.body, RESPONSE_PREVIEW_LIMIT);

        context.log(`API StatusCode: ${result.statusCode}`);
        context.log(`API Response: ${responsePreview}`);

        if (!isSuccess) {
            throw new HttpStatusError(result.statusCode, responsePreview);
        }

        context.log("Status: Success");
    } catch (error) {
        context.error("Status: Failed");

        if (error instanceof HttpStatusError) {
            context.error(`Error Type: HTTP_ERROR`);
            context.error(`HTTP Status: ${error.statusCode}`);
            context.error(`Response: ${error.responsePreview}`);

            const ngrokHint = getNgrokHint(error.responsePreview);
            if (ngrokHint) {
                context.error(`Hint: ${ngrokHint}`);
            }
        } else {
            const message = error instanceof Error ? error.message : String(error);
            context.error(`Error Type: NETWORK_OR_RUNTIME_ERROR`);
            context.error(`Message: ${message}`);
        }

        throw error;
    }

    context.log("========================================");
}

app.timer(TIMER_NAME, {
    schedule: TIMER_SCHEDULE,
    handler: autoCloseShiftTimer
});
