import {
    DetectionPoint,
    DetectionPointState,
    RailChannel,
    RailId,
} from "../models/detector";
import { Relay, RelayState, RelayType } from "../models/relay";
import {
    TrackSection,
    TrackSectionState,
} from "../models/tracksection";

export type SystemLifecycle = "STOPPED" | "STARTING" | "RUNNING";
const MAX_AXLE_COUNT = 64;

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
            rails: Record<RailId, {
                failed: boolean;
                resetRemainingMs: number;
                relays: Record<RelayType, {
                    state: RelayState;
                    lastChanged: Date;
                }>;
            }>;
        };
    }>;
}

export class SimulationEngine {
    private readonly trackSections = new Map<string, TrackSection>();
    private readonly stateListeners = new Set<(state: SimulationState) => void>();
    private readonly resetEndTimes = new Map<string, number>();
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
            for (const rail of this.getRails(section.detectionPoint)) {
                this.setRelayState(rail.rstr, "PICKED");
            }
        }

        await this.delay(3_000);

        console.log("[System] RSTR charging complete; removing 24 V DC supply");
        for (const section of this.trackSections.values()) {
            for (const rail of this.getRails(section.detectionPoint)) {
                this.setRelayState(rail.rstr, "DROPPED");
                this.setRelayState(rail.pr, "PICKED");
            }
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

        for (const rail of this.getRails(detectionPoint)) {
            this.setRelayState(rail.pr, "DROPPED");
            this.setRelayState(rail.acpr, "DROPPED");
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

            for (const rail of this.getRails(detectionPoint)) {
                this.setRelayState(rail.pr, "DROPPED");
                this.setRelayState(rail.acpr, "DROPPED");
            }
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

        for (const rail of this.getRails(detectionPoint)) {
            if (!rail.failed) {
                this.setRelayState(rail.acpr, "PICKED");
            }
        }
        const hasFailedRail = this.getRails(detectionPoint).some(
            (rail) => rail.failed,
        );
        this.setDetectionPointState(
            detectionPoint,
            hasFailedRail ? "FAILED" : "NORMAL",
        );
        this.setTrackSectionState(
            section,
            hasFailedRail ? "FAILED" : "UNOCCUPIED",
        );
        console.log(
            `[Axle count ${detectionPoint.name}] Counts equal; healthy rail ACPR relays PICKED`,
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

    public failRail(sectionName: string, railId: RailId): void {
        this.ensureSystemRunning();
        const section = this.getTrackSection(sectionName);
        const detectionPoint = section.detectionPoint;
        const rail = detectionPoint.getRail(railId);
        const oppositeRail = detectionPoint.getRail(
            railId === "A" ? "B" : "A",
        );

        if (
            section.state !== "UNOCCUPIED" &&
            section.state !== "OCCUPIED"
        ) {
            throw new Error(
                `Rail failure cannot be simulated while ${section.name} is ${section.state}`,
            );
        }

        if (this.isSectionResetting(section.name)) {
            throw new Error(
                `Rail failure cannot be simulated while ${section.name} is resetting`,
            );
        }

        if (rail.failed) {
            throw new Error(
                `Rail ${railId} on ${section.name} is already failed`,
            );
        }

        if (oppositeRail.failed) {
            throw new Error(
                `Rail ${railId} cannot fail while the opposite rail is already failed`,
            );
        }

        if (section.state === "UNOCCUPIED" && (
            rail.pr.state !== "DROPPED" ||
            rail.acpr.state !== "PICKED" ||
            oppositeRail.acpr.state !== "PICKED"
        )) {
            throw new Error(
                `Rail ${railId} can fail only after a balanced train pass with both ACPR relays PICKED and PR DROPPED`,
            );
        }

        rail.failed = true;
        this.setRelayState(rail.acpr, "DROPPED");
        this.setDetectionPointState(detectionPoint, "FAILED");
        if (section.state !== "OCCUPIED") {
            this.setTrackSectionState(section, "FAILED");
        }
        console.log(
            `[Failure ${section.name} rail ${railId}] ACPR DROPPED; reset is inhibited until the section clears`,
        );
    }

    public resetRail(sectionName: string, railId: RailId): Promise<void> {
        this.ensureSystemRunning();
        const section = this.getTrackSection(sectionName);
        const detectionPoint = section.detectionPoint;
        const healthyRail = detectionPoint.getRail(railId);
        const failedRail = detectionPoint.getRail(
            railId === "A" ? "B" : "A",
        );
        const resetKey = this.getResetKey(section.name, railId);

        if (this.resetEndTimes.has(resetKey)) {
            throw new Error(
                `TrackSection "${section.name}" rail ${railId} is already resetting`,
            );
        }

        if (
            healthyRail.failed ||
            !failedRail.failed ||
            section.state === "OCCUPIED" ||
            healthyRail.pr.state !== "DROPPED" ||
            healthyRail.acpr.state !== "PICKED" ||
            failedRail.pr.state !== "DROPPED" ||
            failedRail.acpr.state !== "DROPPED"
        ) {
            throw new Error(
                `Healthy rail ${railId} can reset only after the train clears, when the opposite failed rail PR and ACPR are DROPPED`,
            );
        }

        const resetDurationMs = 10_000;
        this.resetEndTimes.set(resetKey, Date.now() + resetDurationMs);
        this.setRelayState(healthyRail.rstr, "PICKED");
        this.notifyStateChanged();
        console.log(
            `[Auto reset ${section.name}] Healthy rail ${railId} started 10-second reset for failed rail ${failedRail.id}`,
        );

        return this.completeRailReset(section, healthyRail, failedRail);
    }

    private async completeRailReset(
        section: TrackSection,
        healthyRail: RailChannel,
        failedRail: RailChannel,
    ): Promise<void> {
        const resetKey = this.getResetKey(section.name, healthyRail.id);

        while (this.getResetRemainingMs(section.name, healthyRail.id) > 0) {
            await this.delay(
                Math.min(
                    1_000,
                    this.getResetRemainingMs(section.name, healthyRail.id),
                ),
            );
            this.notifyStateChanged();
        }

        section.detectionPoint.resetCounts();
        this.setRelayState(healthyRail.rstr, "DROPPED");
        this.setRelayState(failedRail.pr, "PICKED");
        this.setRelayState(failedRail.acpr, "DROPPED");
        failedRail.failed = false;
        const stillFailed = this.getRails(section.detectionPoint).some(
            (candidate) => candidate.failed,
        );
        this.setDetectionPointState(
            section.detectionPoint,
            stillFailed ? "FAILED" : "NORMAL",
        );
        this.setTrackSectionState(
            section,
            stillFailed ? "FAILED" : "UNOCCUPIED",
        );
        this.resetEndTimes.delete(resetKey);
        this.notifyStateChanged();
        console.log(
            `[Auto reset ${section.name}] Rail ${healthyRail.id} reset rail ${failedRail.id}; failed PR=PICKED, ACPR=DROPPED until next balanced train pass`,
        );
    }

    public isSectionResetting(sectionName: string): boolean {
        const section = this.getTrackSection(sectionName);
        return (["A", "B"] as RailId[]).some((railId) =>
            this.resetEndTimes.has(this.getResetKey(section.name, railId)),
        );
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
                        rails: {
                            A: this.toRailState(section.name, detectionPoint.rails.A),
                            B: this.toRailState(section.name, detectionPoint.rails.B),
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
                `${detectionPoint.name}=FAILED, both rails DROPPED`,
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
        if (
            !Number.isInteger(axleCount) ||
            axleCount <= 0 ||
            axleCount > MAX_AXLE_COUNT
        ) {
            throw new Error(
                `Axle count must be an integer between 1 and ${MAX_AXLE_COUNT}`,
            );
        }
    }

    private getResetRemainingMs(
        sectionName: string,
        railId: RailId,
    ): number {
        const resetEndTime = this.resetEndTimes.get(
            this.getResetKey(sectionName, railId),
        );
        return resetEndTime
            ? Math.max(0, resetEndTime - Date.now())
            : 0;
    }

    private getResetKey(sectionName: string, railId: RailId): string {
        return `${sectionName}:${railId}`;
    }

    private getRails(detectionPoint: DetectionPoint): RailChannel[] {
        return [detectionPoint.rails.A, detectionPoint.rails.B];
    }

    private toRailState(
        sectionName: string,
        rail: RailChannel,
    ): {
        failed: boolean;
        resetRemainingMs: number;
        relays: Record<RelayType, {
            state: RelayState;
            lastChanged: Date;
        }>;
    } {
        return {
            failed: rail.failed,
            resetRemainingMs: this.getResetRemainingMs(sectionName, rail.id),
            relays: {
                RSTR: this.toRelayState(rail.rstr),
                PR: this.toRelayState(rail.pr),
                ACPR: this.toRelayState(rail.acpr),
            },
        };
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
