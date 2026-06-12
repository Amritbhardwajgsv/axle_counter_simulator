import type { SimulationState } from "./engine/simulationengine";
import type { RailId } from "./models/detector";

export type StationRoute = "MAIN" | "UPPER_LOOP" | "LOWER_LOOP";
export type RoutePhase = "ENTERING" | "TRAVERSING" | "EXITING";

export const STATION_ROUTES: Record<StationRoute, string[]> = {
    MAIN: ["1T", "2T", "3T", "4T", "5T", "8T", "9T", "10T", "11T"],
    UPPER_LOOP: ["1T", "2T", "3T", "4T", "6T", "8T", "9T", "10T", "11T"],
    LOWER_LOOP: ["1T", "2T", "3T", "4T", "7T", "9T", "10T", "11T"],
};

export type ClientMessage =
    | {
        type: "START_SYSTEM";
        requestId: string;
    }
    | {
        type: "GET_STATE";
        requestId: string;
    }
    | {
        type: "TRAIN_ENTER";
        requestId: string;
        sectionName: string;
        axleCount: number;
    }
    | {
        type: "TRAIN_EXIT";
        requestId: string;
        sectionName: string;
        axleCount: number;
    }
    | {
        type: "RUN_ROUTE";
        requestId: string;
        route: StationRoute;
        axleCount: number;
        axlePulseMs?: number;
        sectionPauseMs?: number;
    }
    | {
        type: "RESET_SECTION";
        requestId: string;
        sectionName: string;
        railId: RailId;
    }
    | {
        type: "FAIL_RAIL";
        requestId: string;
        sectionName: string;
        railId: RailId;
    };

export type ServerMessage =
    | {
        type: "STATE_SNAPSHOT";
        state: SimulationState;
    }
    | {
        type: "COMMAND_ACCEPTED";
        requestId: string;
    }
    | {
        type: "ROUTE_PROGRESS";
        route: StationRoute;
        sectionName: string;
        sectionIndex: number;
        totalSections: number;
        phase: RoutePhase;
        axleNumber: number;
        axleCount: number;
        movementProgress: number;
    }
    | {
        type: "SYSTEM_CHARGE_PROGRESS";
        remainingMs: number;
    }
    | {
        type: "ROUTE_COMPLETED";
        route: StationRoute;
    }
    | {
        type: "ROUTE_FAILED";
        route: StationRoute;
        message: string;
    }
    | {
        type: "ERROR";
        requestId?: string;
        message: string;
    };
