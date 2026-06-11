import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { SimulationEngine } from "./engine/simulationengine";
import {
    ClientMessage,
    ServerMessage,
    STATION_ROUTES,
    StationRoute,
} from "./protocol";

const PORT = Number(process.env.PORT ?? 8081);
const engine = new SimulationEngine();
const app = express();
const server = createServer(app);
const webSocketServer = new WebSocketServer({ server, path: "/ws" });
let activeRoute: StationRoute | null = null;

const frontendDirectory = path.resolve(process.cwd(), "frontend", "dist");
app.get("/health", (_request, response) => {
    response.status(200).json({
        status: "ok",
        lifecycle: engine.getState().systemLifecycle,
    });
});
app.use(express.static(frontendDirectory));
app.use((_request, response) => {
    response.sendFile(path.join(frontendDirectory, "index.html"));
});

function send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
    }
}

function broadcast(message: ServerMessage): void {
    for (const client of webSocketServer.clients) {
        send(client, message);
    }
}

engine.subscribe((state) => {
    broadcast({ type: "STATE_SNAPSHOT", state });
});

webSocketServer.on("connection", (socket) => {
    send(socket, { type: "STATE_SNAPSHOT", state: engine.getState() });

    socket.on("message", async (data) => {
        let message: ClientMessage;

        try {
            message = parseClientMessage(data.toString());
            await handleMessage(socket, message);
        } catch (error) {
            send(socket, {
                type: "ERROR",
                requestId: getRequestId(data.toString()),
                message: error instanceof Error ? error.message : "Unknown error",
            });
        }
    });
});

async function handleMessage(
    socket: WebSocket,
    message: ClientMessage,
): Promise<void> {
    switch (message.type) {
        case "GET_STATE":
            send(socket, { type: "STATE_SNAPSHOT", state: engine.getState() });
            break;
        case "START_SYSTEM":
            accept(socket, message.requestId);
            await startSystemWithProgress();
            break;
        case "TRAIN_ENTER":
            engine.registerTrainEntry(message.sectionName, message.axleCount);
            accept(socket, message.requestId);
            break;
        case "TRAIN_EXIT":
            engine.registerTrainExit(message.sectionName, message.axleCount);
            accept(socket, message.requestId);
            break;
        case "RUN_ROUTE":
            if (activeRoute) {
                throw new Error(`Route ${activeRoute} is already running`);
            }

            activeRoute = message.route;
            accept(socket, message.requestId);
            void runRoute(
                message.route,
                message.axleCount,
                message.axlePulseMs ?? 120,
                message.sectionPauseMs ?? 450,
            ).finally(() => {
                activeRoute = null;
            });
            break;
    }
}

async function runRoute(
    route: StationRoute,
    axleCount: number,
    axlePulseMs: number,
    sectionPauseMs: number,
): Promise<void> {
    validateDelay(axlePulseMs, "Axle pulse");
    validateDelay(sectionPauseMs, "Section pause");
    const sections = STATION_ROUTES[route];

    try {
        for (const [index, sectionName] of sections.entries()) {
            await moveThroughSection(
                route,
                sectionName,
                index,
                sections.length,
                axleCount,
                axlePulseMs,
                sectionPauseMs,
            );
        }

        broadcast({ type: "ROUTE_COMPLETED", route });
    } catch (error) {
        const message =
            error instanceof Error
                ? error.message
                : `Route ${route} failed`;
        broadcast({
            type: "ROUTE_FAILED",
            route,
            message,
        });
        broadcast({ type: "ERROR", message });
    }
}

async function moveThroughSection(
    route: StationRoute,
    sectionName: string,
    sectionIndex: number,
    totalSections: number,
    axleCount: number,
    axlePulseMs: number,
    sectionPauseMs: number,
): Promise<void> {
    const entryDuration = Math.max(axlePulseMs * (axleCount - 1), 1);
    const exitStart = entryDuration + sectionPauseMs;
    const totalDuration = exitStart + entryDuration;
    const frameMs = 40;
    const startedAt = Date.now();
    let enteredAxles = 0;
    let exitedAxles = 0;

    while (true) {
        const elapsed = Math.min(Date.now() - startedAt, totalDuration);

        while (
            enteredAxles < axleCount &&
            elapsed >= enteredAxles * axlePulseMs
        ) {
            engine.registerTrainEntryPulse(sectionName);
            enteredAxles += 1;
        }

        while (
            exitedAxles < axleCount &&
            elapsed >= exitStart + exitedAxles * axlePulseMs
        ) {
            engine.registerTrainExit(sectionName, 1);
            exitedAxles += 1;
        }

        const phase =
            enteredAxles < axleCount
                ? "ENTERING"
                : exitedAxles > 0
                  ? "EXITING"
                  : "TRAVERSING";

        broadcastRouteProgress(
            route,
            sectionName,
            sectionIndex,
            totalSections,
            phase,
            phase === "EXITING" ? exitedAxles : enteredAxles,
            axleCount,
            elapsed / totalDuration,
        );

        if (elapsed >= totalDuration) {
            break;
        }

        await delay(frameMs);
    }
}

async function startSystemWithProgress(): Promise<void> {
    const startPromise = engine.startSystem();

    for (const remainingMs of [3_000, 2_000, 1_000]) {
        broadcast({ type: "SYSTEM_CHARGE_PROGRESS", remainingMs });
        await delay(1_000);
    }

    await startPromise;
    broadcast({ type: "SYSTEM_CHARGE_PROGRESS", remainingMs: 0 });
}

function broadcastRouteProgress(
    route: StationRoute,
    sectionName: string,
    sectionIndex: number,
    totalSections: number,
    phase: "ENTERING" | "TRAVERSING" | "EXITING",
    axleNumber: number,
    axleCount: number,
    movementProgress: number,
): void {
    broadcast({
        type: "ROUTE_PROGRESS",
        route,
        sectionName,
        sectionIndex,
        totalSections,
        phase,
        axleNumber,
        axleCount,
        movementProgress,
    });
}

function accept(socket: WebSocket, requestId: string): void {
    send(socket, { type: "COMMAND_ACCEPTED", requestId });
}

function parseClientMessage(value: string): ClientMessage {
    const parsed: unknown = JSON.parse(value);

    if (!isRecord(parsed) || typeof parsed.type !== "string") {
        throw new Error("Invalid WebSocket message");
    }

    if (typeof parsed.requestId !== "string" || parsed.requestId.length === 0) {
        throw new Error("requestId is required");
    }

    switch (parsed.type) {
        case "START_SYSTEM":
        case "GET_STATE":
            return parsed as ClientMessage;
        case "TRAIN_ENTER":
        case "TRAIN_EXIT":
            requireSectionAndAxles(parsed);
            return parsed as ClientMessage;
        case "RUN_ROUTE":
            if (
                parsed.route !== "MAIN" &&
                parsed.route !== "UPPER_LOOP" &&
                parsed.route !== "LOWER_LOOP"
            ) {
                throw new Error("Unknown station route");
            }
            requirePositiveInteger(parsed.axleCount, "axleCount");
            optionalDelay(parsed.axlePulseMs, "axlePulseMs");
            optionalDelay(parsed.sectionPauseMs, "sectionPauseMs");
            return parsed as ClientMessage;
        default:
            throw new Error(`Unsupported command "${parsed.type}"`);
    }
}

function requireSectionAndAxles(value: Record<string, unknown>): void {
    if (typeof value.sectionName !== "string") {
        throw new Error("sectionName is required");
    }
    requirePositiveInteger(value.axleCount, "axleCount");
}

function requirePositiveInteger(value: unknown, name: string): void {
    if (!Number.isInteger(value) || Number(value) <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
}

function optionalDelay(value: unknown, name: string): void {
    if (value !== undefined) {
        requirePositiveInteger(value, name);
    }
}

function validateDelay(value: number, name: string): void {
    if (!Number.isInteger(value) || value <= 0 || value > 10_000) {
        throw new Error(`${name} must be between 1 and 10000 milliseconds`);
    }
}

function getRequestId(value: string): string | undefined {
    try {
        const parsed: unknown = JSON.parse(value);
        return isRecord(parsed) && typeof parsed.requestId === "string"
            ? parsed.requestId
            : undefined;
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Station simulator listening on http://localhost:${PORT}`);
});
