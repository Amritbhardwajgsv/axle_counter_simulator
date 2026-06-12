export type RelayState = "PICKED" | "DROPPED";
export type RelayType = "RSTR" | "PR" | "ACPR";
export type TrackSectionState = "FAILED" | "UNOCCUPIED" | "OCCUPIED";
export type SystemLifecycle = "STOPPED" | "STARTING" | "RUNNING";
export type StationRoute = "MAIN" | "UPPER_LOOP" | "LOWER_LOOP";
export type RoutePhase = "ENTERING" | "TRAVERSING" | "EXITING";
export type RailId = "A" | "B";

export interface RelaySnapshot {
    state: RelayState;
    lastChanged: string;
}

export interface TrackSectionSnapshot {
    name: string;
    state: TrackSectionState;
    detectionPoint: {
        name: string;
        state: "FAILED" | "NORMAL";
        enteredAxleCount: number;
        exitedAxleCount: number;
        countDifference: number;
        rails: Record<RailId, {
            failed: boolean;
            resetRemainingMs: number;
            relays: Record<RelayType, RelaySnapshot>;
        }>;
    };
}

export interface SimulationState {
    systemLifecycle: SystemLifecycle;
    trackSections: TrackSectionSnapshot[];
}

export type ClientMessage =
    | { type: "START_SYSTEM"; requestId: string }
    | { type: "GET_STATE"; requestId: string }
    | {
        type: "TRAIN_ENTER" | "TRAIN_EXIT";
        requestId: string;
        sectionName: string;
        axleCount: number;
    }
    | {
        type: "RUN_ROUTE";
        requestId: string;
        route: StationRoute;
        axleCount: number;
        axlePulseMs: number;
        sectionPauseMs: number;
    }
    | {
        type: "RESET_SECTION" | "FAIL_RAIL";
        requestId: string;
        sectionName: string;
        railId: RailId;
    };

export type ServerMessage =
    | { type: "STATE_SNAPSHOT"; state: SimulationState }
    | { type: "COMMAND_ACCEPTED"; requestId: string }
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
    | { type: "SYSTEM_CHARGE_PROGRESS"; remainingMs: number }
    | { type: "ROUTE_COMPLETED"; route: StationRoute }
    | { type: "ROUTE_FAILED"; route: StationRoute; message: string }
    | { type: "ERROR"; requestId?: string; message: string };
