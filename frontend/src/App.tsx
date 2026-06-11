import {
    PointerEvent as ReactPointerEvent,
    WheelEvent as ReactWheelEvent,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import {
    RelayState,
    StationRoute,
    TrackSectionSnapshot,
} from "./types";
import { RouteProgress, useStationSocket } from "./useStationSocket";
import "./styles.css";

const SECTION_POSITIONS: Record<string, { left: number; top: number }> = {
    "1T": { left: 70, top: 180 },
    "2T": { left: 245, top: 180 },
    "3T": { left: 420, top: 180 },
    "4T": { left: 595, top: 455 },
    "5T": { left: 795, top: 180 },
    "6T": { left: 680, top: 20 },
    "7T": { left: 880, top: 535 },
    "8T": { left: 1010, top: 180 },
    "9T": { left: 1185, top: 180 },
    "10T": { left: 1360, top: 180 },
    "11T": { left: 1535, top: 180 },
};

const ROUTE_PATHS: Record<StationRoute, string> = {
    MAIN: "M35 410 H1715",
    UPPER_LOOP:
        "M35 410 H572 C650 365 630 145 745 145 H855 C945 145 925 335 1075 410 H1715",
    LOWER_LOOP:
        "M35 410 H748 C835 470 790 685 945 685 H1100 C1195 685 1160 485 1250 410 H1715",
};

const ROUTE_SECTION_RANGES: Record<
    StationRoute,
    Record<string, [number, number]>
> = {
    MAIN: {
        "1T": [0, 0.112],
        "2T": [0.112, 0.216],
        "3T": [0.216, 0.32],
        "4T": [0.32, 0.432],
        "5T": [0.432, 0.556],
        "8T": [0.556, 0.672],
        "9T": [0.672, 0.776],
        "10T": [0.776, 0.88],
        "11T": [0.88, 1],
    },
    UPPER_LOOP: {
        "1T": [0, 0.094],
        "2T": [0.094, 0.182],
        "3T": [0.182, 0.269],
        "4T": [0.269, 0.343],
        "6T": [0.343, 0.606],
        "8T": [0.606, 0.65],
        "9T": [0.65, 0.738],
        "10T": [0.738, 0.826],
        "11T": [0.826, 1],
    },
    LOWER_LOOP: {
        "1T": [0, 0.084],
        "2T": [0.084, 0.163],
        "3T": [0.163, 0.242],
        "4T": [0.242, 0.405],
        "7T": [0.405, 0.707],
        "9T": [0.707, 0.746],
        "10T": [0.746, 0.825],
        "11T": [0.825, 1],
    },
};

const UPPER_LOOP_PATH =
    "M572 410 C650 365 630 145 745 145 H855 C945 145 925 335 1075 410";
const LOWER_LOOP_PATH =
    "M748 410 C835 470 790 685 945 685 H1100 C1195 685 1160 485 1250 410";

const TRACK_LABELS = [
    { name: "1T", left: 129, top: 438 },
    { name: "2T", left: 311, top: 438 },
    { name: "3T", left: 486, top: 438 },
    { name: "4T", left: 667, top: 438 },
    { name: "5T", left: 864, top: 376 },
    { name: "6T", left: 800, top: 112 },
    { name: "7T", left: 1023, top: 652 },
    { name: "8T", left: 1066, top: 438 },
    { name: "9T", left: 1251, top: 438 },
    { name: "10T", left: 1426, top: 438 },
    { name: "11T", left: 1614, top: 438 },
];

const ROUTES: Array<{
    id: StationRoute;
    title: string;
    path: string;
}> = [
    { id: "MAIN", title: "Main line", path: "1T > 2T > 3T > 4T > 5T > 8T > 9T > 10T > 11T" },
    { id: "UPPER_LOOP", title: "Upper loop", path: "1T > 2T > 3T > 4T > 6T > 8T > 9T > 10T > 11T" },
    { id: "LOWER_LOOP", title: "Lower loop", path: "1T > 2T > 3T > 4T > 7T > 9T > 10T > 11T" },
];

const MIN_AXLE_COUNT = 1;
const MAX_AXLE_COUNT = 64;

export default function App() {
    const {
        state,
        connected,
        error,
        routeProgress,
        chargeRemainingMs,
        clearError,
        send,
    } = useStationSocket();
    const [axleCount, setAxleCount] = useState(12);

    const sections = useMemo(
        () =>
            new Map(
                state?.trackSections.map((section) => [section.name, section]) ??
                    [],
            ),
        [state],
    );

    const running = state?.systemLifecycle === "RUNNING";

    const runRoute = (route: StationRoute) => {
        send({
            type: "RUN_ROUTE",
            route,
            axleCount,
            axlePulseMs: 150,
            sectionPauseMs: 500,
        });
    };

    return (
        <main className="app-shell">
            <header className="topbar">
                <div className="brand">
                    <span className="brand-mark" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                    </span>
                    <div>
                        <p className="brand-name">Frauscher</p>
                        <h1>Axle Counter Simulation</h1>
                        <small>Station track vacancy detection panel</small>
                    </div>
                </div>
                <div className="system-summary">
                    <div className="connection-status">
                        <StatusDot active={connected} />
                        <span>
                            <small>Connection</small>
                            {connected ? "Online" : "Reconnecting"}
                        </span>
                    </div>
                    <strong
                        className={`lifecycle ${state?.systemLifecycle ?? "STOPPED"}`}
                    >
                        {state?.systemLifecycle ?? "NO DATA"}
                    </strong>
                    <button
                        className="start-button"
                        disabled={!connected || state?.systemLifecycle !== "STOPPED"}
                        onClick={() => send({ type: "START_SYSTEM" })}
                    >
                        Start system
                    </button>
                </div>
            </header>

            {error && (
                <button className="error-banner" onClick={clearError}>
                    {error}
                    <span>dismiss</span>
                </button>
            )}

            {state?.systemLifecycle === "STARTING" && (
                <section className="charge-panel">
                    <div className="charge-copy">
                        <span className="voltage-badge">24 V DC</span>
                        <div>
                            <strong>RSTR initialization in progress</strong>
                            <small>
                                Three-second charging cycle. Train commands are
                                inhibited until completion.
                            </small>
                        </div>
                    </div>
                    <div className="charge-timer">
                        {(chargeRemainingMs / 1_000).toFixed(0)}
                        <span>s</span>
                    </div>
                    <div className="charge-track">
                        <i
                            style={{
                                width: `${Math.max(
                                    0,
                                    ((3_000 - chargeRemainingMs) / 3_000) * 100,
                                )}%`,
                            }}
                        />
                    </div>
                </section>
            )}

            <section className="panel">
                <div className="panel-heading">
                    <div>
                        <p className="eyebrow">Live station overview</p>
                        <h2>Track Vacancy Detection</h2>
                    </div>
                    <div className="legend">
                        <Legend color="green" label="Clear" />
                        <Legend color="amber" label="Occupied" />
                        <Legend color="red" label="Failed" />
                    </div>
                </div>

                <p className="mobile-scroll-hint">
                    Drag to move. Pinch or use the controls to zoom.
                </p>
                <PanZoomStation
                    sections={sections}
                    routeProgress={routeProgress}
                />
            </section>

            <section className="panel route-panel">
                <div className="control-heading">
                    <div>
                        <p className="eyebrow">Train movement control</p>
                        <h2>Route Selection</h2>
                    </div>
                    <label>
                        Train axles
                        <input
                            type="number"
                            min={MIN_AXLE_COUNT}
                            max={MAX_AXLE_COUNT}
                            value={axleCount}
                            onChange={(event) => {
                                const value = Number(event.target.value);
                                if (!Number.isFinite(value)) {
                                    return;
                                }

                                setAxleCount(
                                    Math.min(
                                        MAX_AXLE_COUNT,
                                        Math.max(
                                            MIN_AXLE_COUNT,
                                            Math.trunc(value),
                                        ),
                                    ),
                                );
                            }}
                        />
                    </label>
                </div>
                <div className="route-list">
                    {ROUTES.map((route) => (
                        <button
                            key={route.id}
                            className="route-card"
                            disabled={!running || routeProgress !== null}
                            onClick={() => runRoute(route.id)}
                        >
                            <span>{route.title}</span>
                            <small>{route.path}</small>
                        </button>
                    ))}
                </div>
                <RouteStatus progress={routeProgress} />
            </section>
        </main>
    );
}

function PanZoomStation({
    sections,
    routeProgress,
}: {
    sections: Map<string, TrackSectionSnapshot>;
    routeProgress: RouteProgress | null;
}) {
    const viewportRef = useRef<HTMLDivElement>(null);
    const pointersRef = useRef(
        new Map<number, { x: number; y: number }>(),
    );
    const dragRef = useRef({
        pointerId: -1,
        startX: 0,
        startY: 0,
        originX: 0,
        originY: 0,
    });
    const pinchRef = useRef({
        distance: 0,
        scale: 1,
        worldX: 0,
        worldY: 0,
    });
    const [view, setView] = useState({ x: 0, y: 0, scale: 0.82 });
    const [dragging, setDragging] = useState(false);

    const setScale = (nextScale: number) => {
        const viewport = viewportRef.current;
        if (!viewport) {
            return;
        }

        const scale = Math.min(2, Math.max(0.5, nextScale));
        const centerX = viewport.clientWidth / 2;
        const centerY = viewport.clientHeight / 2;

        setView((current) => {
            const worldX = (centerX - current.x) / current.scale;
            const worldY = (centerY - current.y) / current.scale;
            return {
                scale,
                x: centerX - worldX * scale,
                y: centerY - worldY * scale,
            };
        });
    };

    const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
        event.preventDefault();
        const viewport = viewportRef.current;
        if (!viewport) {
            return;
        }

        const bounds = viewport.getBoundingClientRect();
        const pointerX = event.clientX - bounds.left;
        const pointerY = event.clientY - bounds.top;
        const factor = event.deltaY < 0 ? 1.1 : 0.9;

        setView((current) => {
            const scale = Math.min(2, Math.max(0.5, current.scale * factor));
            const worldX = (pointerX - current.x) / current.scale;
            const worldY = (pointerY - current.y) / current.scale;
            return {
                scale,
                x: pointerX - worldX * scale,
                y: pointerY - worldY * scale,
            };
        });
    };

    const handlePointerDown = (
        event: ReactPointerEvent<HTMLDivElement>,
    ) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        pointersRef.current.set(event.pointerId, {
            x: event.clientX,
            y: event.clientY,
        });
        dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: view.x,
            originY: view.y,
        };

        if (pointersRef.current.size === 2) {
            const [first, second] = Array.from(pointersRef.current.values());
            const viewport = viewportRef.current;
            if (viewport) {
                const bounds = viewport.getBoundingClientRect();
                const centerX = (first.x + second.x) / 2 - bounds.left;
                const centerY = (first.y + second.y) / 2 - bounds.top;
                pinchRef.current = {
                    distance: Math.hypot(
                        second.x - first.x,
                        second.y - first.y,
                    ),
                    scale: view.scale,
                    worldX: (centerX - view.x) / view.scale,
                    worldY: (centerY - view.y) / view.scale,
                };
            }
        }
        setDragging(true);
    };

    const handlePointerMove = (
        event: ReactPointerEvent<HTMLDivElement>,
    ) => {
        if (!pointersRef.current.has(event.pointerId)) {
            return;
        }

        pointersRef.current.set(event.pointerId, {
            x: event.clientX,
            y: event.clientY,
        });

        if (pointersRef.current.size === 2) {
            const [first, second] = Array.from(pointersRef.current.values());
            const viewport = viewportRef.current;
            if (!viewport || pinchRef.current.distance === 0) {
                return;
            }

            const bounds = viewport.getBoundingClientRect();
            const centerX = (first.x + second.x) / 2 - bounds.left;
            const centerY = (first.y + second.y) / 2 - bounds.top;
            const distance = Math.hypot(
                second.x - first.x,
                second.y - first.y,
            );
            const scale = Math.min(
                2,
                Math.max(
                    0.5,
                    pinchRef.current.scale *
                        (distance / pinchRef.current.distance),
                ),
            );

            setView({
                scale,
                x: centerX - pinchRef.current.worldX * scale,
                y: centerY - pinchRef.current.worldY * scale,
            });
            return;
        }

        if (!dragging || dragRef.current.pointerId !== event.pointerId) {
            return;
        }

        setView((current) => ({
            ...current,
            x:
                dragRef.current.originX +
                event.clientX -
                dragRef.current.startX,
            y:
                dragRef.current.originY +
                event.clientY -
                dragRef.current.startY,
        }));
    };

    const stopDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
        pointersRef.current.delete(event.pointerId);

        if (dragRef.current.pointerId === event.pointerId) {
            setDragging(false);
            dragRef.current.pointerId = -1;
        }

        if (pointersRef.current.size === 1) {
            const [pointerId, pointer] = Array.from(
                pointersRef.current.entries(),
            )[0];
            dragRef.current = {
                pointerId,
                startX: pointer.x,
                startY: pointer.y,
                originX: view.x,
                originY: view.y,
            };
            setDragging(true);
        }

        if (pointersRef.current.size < 2) {
            pinchRef.current.distance = 0;
        }
    };

    return (
        <div className="diagram-shell">
            <div className="zoom-controls" aria-label="Diagram zoom controls">
                <button
                    type="button"
                    aria-label="Zoom out"
                    onClick={() => setScale(view.scale - 0.15)}
                >
                    -
                </button>
                <output>{Math.round(view.scale * 100)}%</output>
                <button
                    type="button"
                    aria-label="Zoom in"
                    onClick={() => setScale(view.scale + 0.15)}
                >
                    +
                </button>
                <button
                    type="button"
                    className="reset-view"
                    onClick={() => setView({ x: 0, y: 0, scale: 0.82 })}
                >
                    Fit
                </button>
            </div>
            <div
                ref={viewportRef}
                className={`diagram-viewport ${dragging ? "dragging" : ""}`}
                onWheel={handleWheel}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={stopDragging}
                onPointerCancel={stopDragging}
            >
                <div
                    className="diagram-transform"
                    style={{
                        transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                    }}
                >
                    <StationDiagram
                        sections={sections}
                        routeProgress={routeProgress}
                    />
                </div>
            </div>
        </div>
    );
}

function StationDiagram({
    sections,
    routeProgress,
}: {
    sections: Map<string, TrackSectionSnapshot>;
    routeProgress: RouteProgress | null;
}) {
    return (
        <div className="station-diagram">
            <svg
                className="track-lines"
                viewBox="0 0 1750 760"
                preserveAspectRatio="none"
                aria-hidden="true"
            >
                <path className="main-track" d="M35 410 H1715" />
                <path
                    className="loop-track"
                    d={UPPER_LOOP_PATH}
                />
                <path
                    className="loop-track"
                    d={LOWER_LOOP_PATH}
                />
                {[35, 223, 398, 573, 760, 968, 1163, 1338, 1513, 1715].map((x) => (
                    <line key={x} x1={x} y1="397" x2={x} y2="423" />
                ))}
                <PathCut
                    path={ROUTE_PATHS.UPPER_LOOP}
                    progress={ROUTE_SECTION_RANGES.UPPER_LOOP["6T"][0]}
                />
                <PathCut
                    path={ROUTE_PATHS.UPPER_LOOP}
                    progress={ROUTE_SECTION_RANGES.UPPER_LOOP["6T"][1]}
                />
                <PathCut
                    path={ROUTE_PATHS.LOWER_LOOP}
                    progress={ROUTE_SECTION_RANGES.LOWER_LOOP["7T"][0]}
                />
                <PathCut
                    path={ROUTE_PATHS.LOWER_LOOP}
                    progress={ROUTE_SECTION_RANGES.LOWER_LOOP["7T"][1]}
                />
                {routeProgress && (
                    <SvgTrainConsist
                        path={ROUTE_PATHS[routeProgress.route]}
                        progress={getRouteProgress(routeProgress)}
                    />
                )}
            </svg>
            {TRACK_LABELS.map((label) => (
                <span
                    key={label.name}
                    className="track-label"
                    style={{ left: label.left, top: label.top }}
                >
                    {label.name}
                </span>
            ))}
            <div className="direction direction-left">UP direction</div>
            <div className="direction direction-right">DOWN direction</div>
            {Array.from(sections.values()).map((section) => (
                <SectionCard
                    key={section.name}
                    section={section}
                    active={routeProgress?.sectionName === section.name}
                />
            ))}
        </div>
    );
}

function getRouteProgress(progress: RouteProgress): number {
    const range =
        ROUTE_SECTION_RANGES[progress.route][progress.sectionName];

    if (!range) {
        return progress.movementProgress;
    }

    return (
        range[0] +
        (range[1] - range[0]) * progress.movementProgress
    );
}

function SectionCard({
    section,
    active,
}: {
    section: TrackSectionSnapshot;
    active: boolean;
}) {
    const position = SECTION_POSITIONS[section.name];
    const detection = section.detectionPoint;

    return (
        <article
            className={`section-card ${section.state.toLowerCase()} ${active ? "active" : ""}`}
            style={position}
        >
            <div className="section-title">
                <strong>{section.name}</strong>
                <span>{detection.name}</span>
            </div>
            <div className="count-row">
                <span>IN <b>{detection.enteredAxleCount}</b></span>
                <span>OUT <b>{detection.exitedAxleCount}</b></span>
                <span>DELTA <b>{detection.countDifference}</b></span>
            </div>
            <div className="relay-row">
                <RelayLamp name="RSTR" state={detection.relays.RSTR.state} />
                <RelayLamp name="PR" state={detection.relays.PR.state} />
                <RelayLamp name="ACPR" state={detection.relays.ACPR.state} />
            </div>
        </article>
    );
}

function PathCut({
    path,
    progress,
}: {
    path: string;
    progress: number;
}) {
    const pathRef = useRef<SVGPathElement>(null);
    const [transform, setTransform] = useState("");

    useLayoutEffect(() => {
        const element = pathRef.current;
        if (!element) {
            return;
        }

        const length = element.getTotalLength();
        const distance = length * progress;
        const point = element.getPointAtLength(distance);
        const before = element.getPointAtLength(Math.max(0, distance - 2));
        const after = element.getPointAtLength(
            Math.min(length, distance + 2),
        );
        const tangent =
            (Math.atan2(after.y - before.y, after.x - before.x) * 180) /
            Math.PI;
        setTransform(
            `translate(${point.x} ${point.y}) rotate(${tangent + 90})`,
        );
    }, [path, progress]);

    return (
        <>
            <path ref={pathRef} d={path} className="geometry-path" />
            <g className="tc-cut" transform={transform}>
                <line x1="-13" y1="0" x2="13" y2="0" />
            </g>
        </>
    );
}

function SvgTrainConsist({
    path,
    progress,
}: {
    path: string;
    progress: number;
}) {
    const pathRef = useRef<SVGPathElement>(null);
    const [vehicles, setVehicles] = useState<
        Array<{ x: number; y: number; angle: number }>
    >([]);

    useLayoutEffect(() => {
        const element = pathRef.current;
        if (!element) {
            return;
        }

        const length = element.getTotalLength();
        const headDistance =
            Math.min(1, Math.max(0, progress)) * length;
        setVehicles(
            [0].map(() => {
                const distance = headDistance;
                const point = element.getPointAtLength(distance);
                const before = element.getPointAtLength(
                    Math.max(0, distance - 4),
                );
                const after = element.getPointAtLength(
                    Math.min(length, distance + 4),
                );
                const angle =
                    (Math.atan2(
                        after.y - before.y,
                        after.x - before.x,
                    ) *
                        180) /
                    Math.PI;

                return { x: point.x, y: point.y, angle };
            }),
        );
    }, [path, progress]);

    return (
        <>
            <path ref={pathRef} d={path} className="geometry-path" />
            <g className="train-consist">
                {vehicles.map((vehicle, index) => (
                    <TrainVehicle
                        key={index}
                        vehicle={vehicle}
                        locomotive
                    />
                ))}
            </g>
        </>
    );
}

function TrainVehicle({
    vehicle,
    locomotive,
}: {
    vehicle: { x: number; y: number; angle: number };
    locomotive: boolean;
}) {
    return (
        <g
            className={`train-vehicle ${locomotive ? "locomotive" : "coach"}`}
            transform={`translate(${vehicle.x} ${vehicle.y}) rotate(${vehicle.angle})`}
        >
            <rect
                className="vehicle-body"
                x="-34"
                y="-23"
                width="68"
                height="34"
                rx="5"
            />
            {locomotive ? (
                <>
                    <path
                        className="cab-face"
                        d="M-27 -16 H16 L29 -6 V6 H-27 Z"
                    />
                    <rect className="window" x="-17" y="-11" width="12" height="8" />
                    <rect className="window" x="0" y="-11" width="12" height="8" />
                    <circle className="headlight" cx="29" cy="-1" r="3" />
                </>
            ) : (
                <>
                    {[-22, -7, 8, 23].map((x) => (
                        <rect
                            key={x}
                            className="window"
                            x={x - 5}
                            y="-12"
                            width="10"
                            height="8"
                        />
                    ))}
                </>
            )}
            <rect className="underframe" x="-27" y="8" width="54" height="5" />
            <g className="bogie" transform="translate(-20 13)">
                <rect x="-10" y="-3" width="20" height="5" rx="2" />
                <circle cx="-6" cy="4" r="5" />
                <circle cx="6" cy="4" r="5" />
            </g>
            <g className="bogie" transform="translate(20 13)">
                <rect x="-10" y="-3" width="20" height="5" rx="2" />
                <circle cx="-6" cy="4" r="5" />
                <circle cx="6" cy="4" r="5" />
            </g>
            <line className="coupler" x1="-39" y1="5" x2="-34" y2="5" />
            <line className="coupler" x1="34" y1="5" x2="39" y2="5" />
        </g>
    );
}

function RelayLamp({ name, state }: { name: string; state: RelayState }) {
    return (
        <span className="relay">
            <i className={state.toLowerCase()} />
            {name}
        </span>
    );
}

function RouteStatus({ progress }: { progress: RouteProgress | null }) {
    if (!progress) {
        return <p className="route-status">No route movement active</p>;
    }

    return (
        <p className="route-status active-route">
            <span>
                {progress.route.replace("_", " ")}: {progress.sectionName}
                <b>
                    {progress.phase === "TRAVERSING"
                        ? " train body crossing"
                        : ` ${progress.phase.toLowerCase()} axle ${progress.axleNumber}/${progress.axleCount}`}
                </b>
            </span>
            <span>
                {progress.sectionIndex + 1} / {progress.totalSections}
            </span>
        </p>
    );
}

function StatusDot({ active }: { active: boolean }) {
    return <i className={`connection-dot ${active ? "online" : ""}`} />;
}

function Legend({ color, label }: { color: string; label: string }) {
    return (
        <span>
            <i className={color} />
            {label}
        </span>
    );
}
