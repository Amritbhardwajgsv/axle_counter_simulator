import { DetectionPoint } from "./detector";

export type TrackSectionState = "FAILED" | "UNOCCUPIED" | "OCCUPIED";

export class TrackSection {
    public state: TrackSectionState;

    constructor(
        public readonly name: string,
        public readonly detectionPoint: DetectionPoint,
        initialState: TrackSectionState = "FAILED",
    ) {
        this.state = initialState;
    }
}
