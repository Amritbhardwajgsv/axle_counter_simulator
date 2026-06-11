import {
    DetectionPoint,
    DetectionPointState,
} from "../models/detector";
import { Relay, RelayState, RelayType } from "../models/relay";
import {
    TrackSection,
    TrackSectionState,
} from "../models/tracksection";

export type SystemLifecycle = "STOPPED" | "STARTING" | "RUNNING";

export interface SimulationState {
    systemLifecycle: SystemLifecycle;
    trackSections: Array<{
        name: string;
        state: TrackSectionState;
        detectionPoint: {
            name: string;
            state: DetectionPointState;
            enteredAxleCount: number;
            exitedAxleCount: number;
            countDifference: number;
            relays: Record<RelayType, {
                state: RelayState;
                lastChanged: Date;
            }>;
        };
    }>;
}

export class SimulationEngine {
    private readonly trackSections = new Map<string, TrackSection>();
    private readonly stateListeners = new Set<(state: SimulationState) => void>();
    private readonly trainPassTimeoutMs: number;
    private systemLifecycle: SystemLifecycle = "STOPPED";

    constructor(trainPassTimeoutMs = 3_000) {
        if (trainPassTimeoutMs < 0) {
            throw new Error("Train pass timeout cannot be negative");
        }

        this.trainPassTimeoutMs = trainPassTimeoutMs;
        this.initialize();
    }

    public async startSystem(): Promise<void> {
        if (this.systemLifecycle !== "STOPPED") {
            throw new Error(
                `System cannot start while ${this.systemLifecycle}`,
            );
        }

        this.systemLifecycle = "STARTING";
        this.notifyStateChanged();
        console.log("[System] Starting");
        console.log("[System] Applying 24 V DC to all RSTR relays for 3 seconds");

        for (const section of this.trackSections.values()) {
            this.setRelayState(section.detectionPoint.rstr, "PICKED");
        }

        await this.delay(3_000);

        console.log("[System] RSTR charging complete; removing 24 V DC supply");
        for (const section of this.trackSections.values()) {
            this.setRelayState(section.detectionPoint.rstr, "DROPPED");
            this.setRelayState(section.detectionPoint.pr, "PICKED");
            this.setDetectionPointState(section.detectionPoint, "NORMAL");
            this.setTrackSectionState(section, "UNOCCUPIED");
        }

        this.systemLifecycle = "RUNNING";
        this.notifyStateChanged();
        console.log("[System] Started");
    }

    public subscribe(
        listener: (state: SimulationState) => void,
    ): () => void {
        this.stateListeners.add(listener);
        listener(this.getState());

        return () => {
            this.stateListeners.delete(listener);
        };
    }

    public registerTrainEntry(sectionName: string, axleCount: number): void {
        this.ensureSystemRunning();
        const section = this.getTrackSection(sectionName);
        this.validateAxleCount(axleCount);

        if (section.state !== "UNOCCUPIED") {
            throw new Error(
                `TrackSection "${section.name}" cannot receive a train while ${section.state}`,
            );
        }

        const detectionPoint = section.detectionPoint;
        detectionPoint.beginCounting(axleCount);

        console.log(
            `[Entry contact ${detectionPoint.name}] Counted ${axleCount} axles entering ${section.name}`,
        );
        this.setTrackSectionState(section, "OCCUPIED");

        if (detectionPoint.pr.state === "PICKED") {
            console.log(
                `[Train] First movement through ${section.name}; PR will drop and remain dropped`,
            );
            this.setRelayState(detectionPoint.pr, "DROPPED");
        } else {
            console.log(
                `[Train] Subsequent movement through ${section.name}; PR remains DROPPED`,
            );
        }

        if (detectionPoint.acpr.state === "PICKED") {
            this.setRelayState(detectionPoint.acpr, "DROPPED");
        } else {
            console.log(
                `[Relay ${detectionPoint.acpr.id}] remains DROPPED while axle counts are unequal`,
            );
        }
    }

    public registerTrainEntryPulse(sectionName: string): void {
        this.ensureSystemRunning();
        const section = this.getTrackSection(sectionName);
        const detectionPoint = section.detectionPoint;

        if (section.state === "UNOCCUPIED") {
            detectionPoint.beginCounting(1);
            console.log(
                `[Entry contact ${detectionPoint.name}] Axle 1 entered ${section.name}`,
            );
            this.setTrackSectionState(section, "OCCUPIED");

            if (detectionPoint.pr.state === "PICKED") {
                this.setRelayState(detectionPoint.pr, "DROPPED");
            }

            this.setRelayState(detectionPoint.acpr, "DROPPED");
            return;
        }

        if (
            section.state !== "OCCUPIED" ||
            detectionPoint.exitedAxleCount > 0
        ) {
            throw new Error(
                `TrackSection "${section.name}" cannot count another entering axle`,
            );
        }

        detectionPoint.countEnteringAxles(1);
        this.notifyStateChanged();
        console.log(
            `[Entry contact ${detectionPoint.name}] Axle ${detectionPoint.enteredAxleCount} entered ${section.name}`,
        );
    }

    public registerTrainExit(sectionName: string, axleCount: number): void {
        this.ensureSystemRunning();
        const section = this.getTrackSection(sectionName);
        this.validateAxleCount(axleCount);

        if (section.state !== "OCCUPIED") {
            throw new Error(
                `TrackSection "${section.name}" has no active train movement`,
            );
        }

        const detectionPoint = section.detectionPoint;
        const remainingAxles =
            detectionPoint.enteredAxleCount -
            detectionPoint.exitedAxleCount;

        if (axleCount > remainingAxles) {
            throw new Error(
                `Exit count ${axleCount} exceeds the ${remainingAxles} remaining axles for ${section.name}`,
            );
        }

        detectionPoint.countExitingAxles(axleCount);
        const difference =
            detectionPoint.enteredAxleCount - detectionPoint.exitedAxleCount;
        this.notifyStateChanged();

        console.log(
            `[Exit contact ${detectionPoint.name}] Counted ${axleCount} axles; ` +
            `entered=${detectionPoint.enteredAxleCount}, ` +
            `exited=${detectionPoint.exitedAxleCount}, difference=${difference}`,
        );

        if (!detectionPoint.hasBalancedCount()) {
            console.log(
                `[Axle count ${detectionPoint.name}] Counts unequal; ` +
                `${section.name} remains OCCUPIED and ACPR remains DROPPED`,
            );
            return;
        }

        this.setRelayState(detectionPoint.acpr, "PICKED");
        this.setTrackSectionState(section, "UNOCCUPIED");
        console.log(
            `[Axle count ${detectionPoint.name}] Counts equal; ACPR PICKED and ${section.name} cleared`,
        );
        detectionPoint.resetCounts();
        this.notifyStateChanged();
        console.log(
            `[Axle count ${detectionPoint.name}] Counters reset for the next train`,
        );
    }

    public async simulateTrainPass(
        sectionName: string,
        axleCount: number,
    ): Promise<void> {
        this.registerTrainEntry(sectionName, axleCount);
        await this.delay(this.trainPassTimeoutMs);
        this.registerTrainExit(sectionName, axleCount);
    }

    public getState(): SimulationState {
        return {
            systemLifecycle: this.systemLifecycle,
            trackSections: Array.from(this.trackSections.values(), (section) => {
                const detectionPoint = section.detectionPoint;

                return {
                    name: section.name,
                    state: section.state,
                    detectionPoint: {
                        name: detectionPoint.name,
                        state: detectionPoint.state,
                        enteredAxleCount: detectionPoint.enteredAxleCount,
                        exitedAxleCount: detectionPoint.exitedAxleCount,
                        countDifference:
                            detectionPoint.enteredAxleCount -
                            detectionPoint.exitedAxleCount,
                        relays: {
                            RSTR: this.toRelayState(detectionPoint.rstr),
                            PR: this.toRelayState(detectionPoint.pr),
                            ACPR: this.toRelayState(detectionPoint.acpr),
                        },
                    },
                };
            }),
        };
    }

    private initialize(): void {
        for (let sectionNumber = 1; sectionNumber <= 11; sectionNumber += 1) {
            const sectionName = `${sectionNumber}T`;
            const detectionPoint = new DetectionPoint(`${sectionNumber}D`);
            const section = new TrackSection(sectionName, detectionPoint);

            this.trackSections.set(sectionName, section);
            console.log(
                `[Initialize] ${section.name}=FAILED, ` +
                `${detectionPoint.name}=FAILED, RSTR=DROPPED, ` +
                "PR=DROPPED, ACPR=DROPPED",
            );
        }
    }

    private setTrackSectionState(
        section: TrackSection,
        state: TrackSectionState,
    ): void {
        if (section.state === state) {
            return;
        }

        const previousState = section.state;
        section.state = state;
        this.notifyStateChanged();
        console.log(
            `[TrackSection ${section.name}] ${previousState} -> ${state}`,
        );
    }

    private setDetectionPointState(
        detectionPoint: DetectionPoint,
        state: DetectionPointState,
    ): void {
        if (detectionPoint.state === state) {
            return;
        }

        const previousState = detectionPoint.state;
        detectionPoint.state = state;
        this.notifyStateChanged();
        console.log(
            `[DetectionPoint ${detectionPoint.name}] ${previousState} -> ${state}`,
        );
    }

    private setRelayState(relay: Relay, state: RelayState): void {
        const previousState = relay.state;
        const changed = relay.setState(state);

        if (!changed) {
            return;
        }

        this.notifyStateChanged();
        console.log(
            `[Relay ${relay.id}] ${previousState} -> ${state} at ` +
            relay.lastChanged.toISOString(),
        );
    }

    private ensureSystemRunning(): void {
        if (this.systemLifecycle !== "RUNNING") {
            throw new Error(
                `Train events are not allowed while system is ${this.systemLifecycle}`,
            );
        }
    }

    private getTrackSection(sectionName: string): TrackSection {
        const section = this.trackSections.get(sectionName.toUpperCase());

        if (!section) {
            throw new Error(`TrackSection "${sectionName}" does not exist`);
        }

        return section;
    }

    private validateAxleCount(axleCount: number): void {
        if (!Number.isInteger(axleCount) || axleCount <= 0) {
            throw new Error("Axle count must be a positive integer");
        }
    }

    private toRelayState(relay: Relay): {
        state: RelayState;
        lastChanged: Date;
    } {
        return {
            state: relay.state,
            lastChanged: new Date(relay.lastChanged),
        };
    }

    private delay(milliseconds: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }

    private notifyStateChanged(): void {
        if (this.stateListeners.size === 0) {
            return;
        }

        const state = this.getState();
        for (const listener of this.stateListeners) {
            listener(state);
        }
    }
}
