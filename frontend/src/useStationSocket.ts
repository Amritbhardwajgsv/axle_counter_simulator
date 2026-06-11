import { useCallback, useEffect, useRef, useState } from "react";
import {
    ClientMessage,
    ServerMessage,
    SimulationState,
    StationRoute,
    RoutePhase,
} from "./types";

export interface RouteProgress {
    route: StationRoute;
    sectionName: string;
    sectionIndex: number;
    totalSections: number;
    phase: RoutePhase;
    axleNumber: number;
    axleCount: number;
    movementProgress: number;
}

type ClientMessageInput =
    ClientMessage extends infer Message
        ? Message extends { requestId: string }
            ? Omit<Message, "requestId">
            : never
        : never;

function socketUrl(): string {
    const configured = import.meta.env.VITE_WS_URL as string | undefined;
    if (configured) {
        return configured;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host =
        window.location.port === "5173"
            ? `${window.location.hostname}:8081`
            : window.location.host;
    return `${protocol}//${host}/ws`;
}

export function useStationSocket() {
    const socketRef = useRef<WebSocket | null>(null);
    const reconnectTimerRef = useRef<number | null>(null);
    const [state, setState] = useState<SimulationState | null>(null);
    const [connected, setConnected] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [routeProgress, setRouteProgress] =
        useState<RouteProgress | null>(null);
    const [chargeRemainingMs, setChargeRemainingMs] = useState(0);

    useEffect(() => {
        let disposed = false;

        const connect = () => {
            if (disposed) {
                return;
            }

            const socket = new WebSocket(socketUrl());
            socketRef.current = socket;

            socket.addEventListener("open", () => {
                setConnected(true);
                setError(null);
                socket.send(
                    JSON.stringify({
                        type: "GET_STATE",
                        requestId: crypto.randomUUID(),
                    }),
                );
            });

            socket.addEventListener("message", (event) => {
                const message = JSON.parse(event.data as string) as ServerMessage;

                switch (message.type) {
                    case "STATE_SNAPSHOT":
                        setState(message.state);
                        break;
                    case "ROUTE_PROGRESS":
                        setRouteProgress(message);
                        break;
                    case "SYSTEM_CHARGE_PROGRESS":
                        setChargeRemainingMs(message.remainingMs);
                        break;
                    case "ROUTE_COMPLETED":
                        setRouteProgress(null);
                        break;
                    case "ROUTE_FAILED":
                        setRouteProgress(null);
                        setError(message.message);
                        break;
                    case "ERROR":
                        setError(message.message);
                        break;
                    case "COMMAND_ACCEPTED":
                        setError(null);
                        break;
                }
            });

            socket.addEventListener("close", () => {
                setConnected(false);
                socketRef.current = null;
                if (!disposed) {
                    reconnectTimerRef.current = window.setTimeout(connect, 1500);
                }
            });

            socket.addEventListener("error", () => {
                setError("WebSocket connection failed");
                socket.close();
            });
        };

        connect();

        return () => {
            disposed = true;
            if (reconnectTimerRef.current !== null) {
                window.clearTimeout(reconnectTimerRef.current);
            }
            socketRef.current?.close();
        };
    }, []);

    const send = useCallback((message: ClientMessageInput) => {
        const socket = socketRef.current;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            setError("Station server is not connected");
            return;
        }

        socket.send(
            JSON.stringify({
                ...message,
                requestId: crypto.randomUUID(),
            }),
        );
    }, []);

    return {
        state,
        connected,
        error,
        routeProgress,
        chargeRemainingMs,
        clearError: () => setError(null),
        send,
    };
}
