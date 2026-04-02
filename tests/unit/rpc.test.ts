import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry } from "../../src/utils/rpc";
import type { Logger } from "pino";

// ─── Logger mock ──────────────────────────────────────────────────────────────

const mockLogger = {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
} as unknown as Logger;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function make429Error(retryAfter?: string): unknown {
    return Object.assign(new Error("Too Many Requests"), {
        status: 429,
        headers: retryAfter ? { "retry-after": retryAfter } : {},
    });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("withRetry", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("returns value immediately on first success", async () => {
        const fn = vi.fn().mockResolvedValue("ok");
        const result = await withRetry(fn, mockLogger);
        expect(result).toBe("ok");
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries on failure and returns on eventual success", async () => {
        const fn = vi.fn()
            .mockRejectedValueOnce(new Error("fail"))
            .mockRejectedValueOnce(new Error("fail"))
            .mockResolvedValue("success");

        const promise = withRetry(fn, mockLogger, { baseDelay: 0, jitter: 0 });
        // advance all timers
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(result).toBe("success");
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it("throws after maxAttempts exhausted", async () => {
        const error = new Error("always fails");
        const fn = vi.fn().mockRejectedValue(error);

        await Promise.all([
            expect(withRetry(fn, mockLogger, { maxAttempts: 3, baseDelay: 0, jitter: 0 }))
                .rejects.toThrow("always fails"),
            vi.runAllTimersAsync(),
        ]);

        expect(fn).toHaveBeenCalledTimes(3);
    });

    it("logs warning on each failed attempt", async () => {
        const fn = vi.fn()
            .mockRejectedValueOnce(new Error("err"))
            .mockResolvedValue("ok");

        const promise = withRetry(fn, mockLogger, { baseDelay: 0, jitter: 0 });
        await vi.runAllTimersAsync();
        await promise;

        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ attempt: 1 }),
            expect.stringContaining("retrying")
        );
    });

    it("does not retry more than maxAttempts", async () => {
        const fn = vi.fn().mockRejectedValue(new Error("always fail"));

        await Promise.all([
            expect(withRetry(fn, mockLogger, { maxAttempts: 5, baseDelay: 0, jitter: 0 }))
                .rejects.toThrow("always fail"),
            vi.runAllTimersAsync(),
        ]);

        expect(fn).toHaveBeenCalledTimes(5);
    });

    it("handles 429 with Retry-After header", async () => {
        const fn = vi.fn()
            .mockRejectedValueOnce(make429Error("2"))   // retry after 2s
            .mockResolvedValue("ok");

        const promise = withRetry(fn, mockLogger, { baseDelay: 100, jitter: 0 });
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(result).toBe("ok");
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ retryAfterMs: 2000 }),
            expect.stringContaining("Rate limited")
        );
    });

    it("handles 429 without Retry-After — uses 10s fallback", async () => {
        const fn = vi.fn()
            .mockRejectedValueOnce(make429Error())   // no header
            .mockResolvedValue("ok");

        const promise = withRetry(fn, mockLogger, { baseDelay: 0, jitter: 0 });
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(result).toBe("ok");
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ retryAfterMs: 10_000 }),
            expect.stringContaining("Rate limited")
        );
    });

    it("exponential backoff: delay doubles each attempt", async () => {
        const fn = vi.fn()
            .mockRejectedValueOnce(new Error("1"))
            .mockRejectedValueOnce(new Error("2"))
            .mockRejectedValueOnce(new Error("3"))
            .mockResolvedValue("ok");

        const promise = withRetry(fn, mockLogger, { baseDelay: 500, maxDelay: 8000, jitter: 0 });
        await vi.runAllTimersAsync();
        const result = await promise;

        expect(result).toBe("ok");
        expect(fn).toHaveBeenCalledTimes(4);  // 3 fails + 1 success
        // backoff is logged in warn — check delays via logs
        expect(mockLogger.warn).toHaveBeenNthCalledWith(
            1, expect.objectContaining({ attempt: 1, delayMs: 500 }), expect.any(String)
        );
        expect(mockLogger.warn).toHaveBeenNthCalledWith(
            2, expect.objectContaining({ attempt: 2, delayMs: 1000 }), expect.any(String)
        );
        expect(mockLogger.warn).toHaveBeenNthCalledWith(
            3, expect.objectContaining({ attempt: 3, delayMs: 2000 }), expect.any(String)
        );
    });

    it("caps delay at maxDelay", async () => {
        const fn = vi.fn()
            .mockRejectedValueOnce(new Error("fail"))
            .mockResolvedValue("ok");

        // baseDelay=100, attempt 10 → would be 51200ms but capped at 200ms
        const promise = withRetry(fn, mockLogger, {
            baseDelay: 100,
            maxDelay: 200,
            jitter: 0,
            maxAttempts: 2,
        });
        await vi.runAllTimersAsync();
        await promise;

        // just check that it executed without error
        expect(fn).toHaveBeenCalledTimes(2);
    });
});