import * as React from "react";
import { invoke } from "@tauri-apps/api/core";
import { BarChart3, FileJson, Folder, Home, Plus, Search, Settings, Upload } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from "recharts";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import JsonViewerPage from "@/pages/JsonViewerPage";

type WorkspaceProject = {
  id: string;
  name: string;
  folder_path: string;
  json_file_path?: string | null;
  updated_at: number;
};

type WorkspaceOverview = {
  root_path: string;
  projects_path: string;
  projects: WorkspaceProject[];
};

type ParsedRoute =
  | { kind: "home" }
  | { kind: "project"; projectId: string }
  | { kind: "team"; projectId: string; team: string }
  | { kind: "viewer"; projectId?: string };

type ProjectSection = "overview" | "config" | "compare" | "picklist" | "scouts" | "teams" | "data";
type JsonEntry = Record<string, unknown>;
type TeamSeriesPoint = { match: number; value: number; scouter: string };
type TeamChartPoint = { match: number; value: number | null; compareValue: number | null; scouter: string; compareScouter: string };
type DataGraphType = "scatter" | "bar";

function parseHashRoute(hashValue: string): ParsedRoute {
  const hash = hashValue || "#/";

  const pathOnly = hash.split("?")[0] ?? "#/";
  const decodedPath = decodeURIComponent(pathOnly);
  const teamMatch = decodedPath.match(/^#\/project\/([^/]+)\/team\/(.+)$/);

  if (teamMatch) {
    return {
      kind: "team",
      projectId: teamMatch[1],
      team: teamMatch[2],
    };
  }

  if (hash.startsWith("#/project/")) {
    const projectId = decodeURIComponent(hash.replace("#/project/", ""));
    if (projectId) {
      return { kind: "project", projectId };
    }
  }

  if (hash.startsWith("#/viewer")) {
    const queryIndex = hash.indexOf("?");
    const query = queryIndex >= 0 ? hash.slice(queryIndex + 1) : "";
    const params = new URLSearchParams(query);

    const projectIdValue = params.get("projectId") ?? undefined;

    return {
      kind: "viewer",
      projectId: projectIdValue,
    };
  }

  return { kind: "home" };
}

function buildProjectHash(projectId: string): string {
  return `#/project/${encodeURIComponent(projectId)}`;
}

function buildTeamHash(projectId: string, team: string): string {
  return `#/project/${encodeURIComponent(projectId)}/team/${encodeURIComponent(team)}`;
}

function buildViewerHash(project?: WorkspaceProject): string {
  const params = new URLSearchParams();

  if (project?.id) {
    params.set("projectId", project.id);
  }

  const query = params.toString();
  return query.length ? `#/viewer?${query}` : "#/viewer";
}

function fromUnixSecondsToUpdatedLabel(timestamp: number): string {
  if (!timestamp || Number.isNaN(timestamp)) {
    return "Last edited: Unknown";
  }

  const then = new Date(timestamp * 1000);
  const now = new Date();
  const msInDay = 24 * 60 * 60 * 1000;

  const dayDiff = Math.floor(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) /
      msInDay,
  );

  if (dayDiff <= 0) {
    return "Last edited: Today";
  }

  if (dayDiff === 1) {
    return "Last edited: Yesterday";
  }

  return `Last edited: ${then.toLocaleString("en-US", { month: "short" })} ${then.getDate()}`;
}

const cardGradient =
  "radial-gradient(circle at 20% 20%, rgba(59,130,246,0.16), transparent 42%), radial-gradient(circle at 80% 35%, rgba(30,64,175,0.25), transparent 45%), linear-gradient(180deg, rgba(15,23,42,0.9), rgba(10,15,32,0.95))";

function App() {
  const [hashRoute, setHashRoute] = React.useState(window.location.hash || "#/");
  const [workspace, setWorkspace] = React.useState<WorkspaceOverview | null>(null);
  const [isLoadingWorkspace, setIsLoadingWorkspace] = React.useState(true);
  const [workspaceError, setWorkspaceError] = React.useState("");
  const [search, setSearch] = React.useState("");

  const [isCreateDialogOpen, setIsCreateDialogOpen] = React.useState(false);
  const [isCreatingProject, setIsCreatingProject] = React.useState(false);
  const [createProjectName, setCreateProjectName] = React.useState("Untitled Project");

  const [projectSection, setProjectSection] = React.useState<ProjectSection>("overview");
  const [teamSearch, setTeamSearch] = React.useState("");
  const [teamNumbers, setTeamNumbers] = React.useState<string[]>([]);
  const [selectedTeam, setSelectedTeam] = React.useState("");
  const [scoutSearch, setScoutSearch] = React.useState("");
  const [scoutNames, setScoutNames] = React.useState<string[]>([]);
  const [selectedScout, setSelectedScout] = React.useState("");
  const [jsonEntries, setJsonEntries] = React.useState<JsonEntry[]>([]);
  const [selectedDataXTag, setSelectedDataXTag] = React.useState("");
  const [selectedDataYTag, setSelectedDataYTag] = React.useState("");
  const [selectedDataYTagSecondary, setSelectedDataYTagSecondary] = React.useState("");
  const [activeDataAxis, setActiveDataAxis] = React.useState<"x" | "y" | "y2" | null>("x");
  const [dataGraphType, setDataGraphType] = React.useState<DataGraphType>("scatter");
  const [dataTeamSearch, setDataTeamSearch] = React.useState("");
  const [dataTagSelectionError, setDataTagSelectionError] = React.useState("");
  const [isDataGraphFullscreen, setIsDataGraphFullscreen] = React.useState(false);
  const [teamTagOrder, setTeamTagOrder] = React.useState<string[]>([]);
  const [selectedTeamTag, setSelectedTeamTag] = React.useState("");
  const [compareTeamInput, setCompareTeamInput] = React.useState("");
  const [isTeamGraphFullscreen, setIsTeamGraphFullscreen] = React.useState(false);
  const [draggingTeamTag, setDraggingTeamTag] = React.useState<string | null>(null);
  const [animatedChartData, setAnimatedChartData] = React.useState<TeamChartPoint[]>([]);
  const [isLoadingIndex, setIsLoadingIndex] = React.useState(false);
  const [indexError, setIndexError] = React.useState("");

  React.useEffect(() => {
    const onHashChange = () => {
      setHashRoute(window.location.hash || "#/");
    };

    window.addEventListener("hashchange", onHashChange);

    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  const refreshWorkspace = React.useCallback(async () => {
    setIsLoadingWorkspace(true);

    try {
      const overview = await invoke<WorkspaceOverview>("get_goonhq_workspace_overview");
      setWorkspace(overview);
      setWorkspaceError("");
    } catch (error) {
      setWorkspaceError(`Unable to load local workspace: ${String(error)}`);
    } finally {
      setIsLoadingWorkspace(false);
    }
  }, []);

  React.useEffect(() => {
    void refreshWorkspace();
  }, [refreshWorkspace]);

  const route = React.useMemo(() => parseHashRoute(hashRoute), [hashRoute]);

  const selectedProject = React.useMemo(() => {
    if (!workspace) {
      return null;
    }

    const projectId =
      route.kind === "project"
        ? route.projectId
        : route.kind === "viewer"
          ? route.projectId
          : route.kind === "team"
            ? route.projectId
            : undefined;
    if (!projectId) {
      return null;
    }

    return workspace.projects.find((project) => project.id === projectId) ?? null;
  }, [route, workspace]);

  React.useEffect(() => {
    setTeamSearch("");
    setSelectedTeam("");
    setScoutSearch("");
    setSelectedScout("");
    setIndexError("");

    const needsIndexForProjectTabs = route.kind === "project" && (projectSection === "teams" || projectSection === "scouts" || projectSection === "data");
    const needsIndexForTeamPage = route.kind === "team";

    if (!needsIndexForProjectTabs && !needsIndexForTeamPage) {
      return;
    }

    if (!selectedProject?.json_file_path) {
      setJsonEntries([]);
      setTeamNumbers([]);
      setScoutNames([]);
      return;
    }

    let isCancelled = false;

    const loadIndex = async () => {
      setIsLoadingIndex(true);

      try {
        const content = await invoke<string>("read_json_file", {
          path: selectedProject.json_file_path,
        });

        const parsed = JSON.parse(content) as unknown;
        const rawEntries = Array.isArray(parsed)
          ? parsed
          : parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).data)
            ? ((parsed as Record<string, unknown>).data as unknown[])
            : [];

        const entries = rawEntries
          .filter((entry): entry is JsonEntry => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry));

        const uniqueTeams = new Set<string>();
        const uniqueScouts = new Set<string>();

        for (const entry of entries) {
          const teamValue = entry.team;
          if (typeof teamValue === "string" && teamValue.trim()) {
            uniqueTeams.add(teamValue.trim());
          } else if (typeof teamValue === "number") {
            uniqueTeams.add(String(teamValue));
          }

          const scoutValue = entry.scouter;
          if (typeof scoutValue === "string" && scoutValue.trim()) {
            uniqueScouts.add(scoutValue.trim());
          }
        }

        if (!isCancelled) {
          setJsonEntries(entries);
          setTeamNumbers(Array.from(uniqueTeams).sort((left, right) => left.localeCompare(right, undefined, { numeric: true })));
          setScoutNames(Array.from(uniqueScouts).sort((left, right) => left.localeCompare(right)));
          setIndexError("");
        }
      } catch (error) {
        if (!isCancelled) {
          setJsonEntries([]);
          setTeamNumbers([]);
          setScoutNames([]);
          setIndexError(`Unable to read teams/scouts from JSON: ${String(error)}`);
        }
      } finally {
        if (!isCancelled) {
          setIsLoadingIndex(false);
        }
      }
    };

    void loadIndex();

    return () => {
      isCancelled = true;
    };
  }, [projectSection, route.kind, selectedProject?.json_file_path]);

  const filteredTeamNumbers = React.useMemo(() => {
    const term = teamSearch.trim().toLowerCase();
    if (!term) {
      return teamNumbers;
    }

    return teamNumbers.filter((team) => team.toLowerCase().includes(term));
  }, [teamNumbers, teamSearch]);

  const filteredScoutNames = React.useMemo(() => {
    const term = scoutSearch.trim().toLowerCase();
    if (!term) {
      return scoutNames;
    }

    return scoutNames.filter((scout) => scout.toLowerCase().includes(term));
  }, [scoutNames, scoutSearch]);

  const activeTeam = route.kind === "team" ? route.team : "";
  const statsTeam = route.kind === "team" ? activeTeam : selectedTeam;
  const excludedDataTags = React.useMemo(() => new Set(["team", "match", "scouter", "scouters"]), []);

  const allNumericTags = React.useMemo(() => {
    const tags = new Set<string>();

    for (const entry of jsonEntries) {
      for (const [tag, value] of Object.entries(entry)) {
        if (excludedDataTags.has(tag) || typeof value === "boolean") {
          continue;
        }

        if (typeof value === "number" && Number.isFinite(value)) {
          tags.add(tag);
          continue;
        }

        if (typeof value === "string" && value.trim() !== "") {
          const parsed = Number(value);
          if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
            tags.add(tag);
          }
        }
      }
    }

    return Array.from(tags).sort((left, right) => left.localeCompare(right));
  }, [excludedDataTags, jsonEntries]);

  React.useEffect(() => {
    setSelectedDataXTag((previous) => {
      if (previous && allNumericTags.includes(previous)) {
        return previous;
      }
      return allNumericTags[0] ?? "";
    });

    setSelectedDataYTag((previous) => {
      if (previous && allNumericTags.includes(previous)) {
        return previous;
      }
      if (allNumericTags.length >= 2) {
        return allNumericTags[1];
      }
      return allNumericTags[0] ?? "";
    });
  }, [allNumericTags]);

  const extractNumericValue = React.useCallback((entry: JsonEntry, tag: string) => {
    const raw = entry[tag];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      return raw;
    }
    if (typeof raw === "string" && raw.trim() !== "") {
      const parsed = Number(raw);
      if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return null;
  }, []);

  const parseAutoTeleopTag = React.useCallback((tag: string) => {
    if (tag.startsWith("auto.")) {
      return { phase: "auto" as const, base: tag.slice("auto.".length) };
    }
    if (tag.startsWith("teleop.")) {
      return { phase: "teleop" as const, base: tag.slice("teleop.".length) };
    }
    return null;
  }, []);

  const isAutoTeleopPair = React.useCallback(
    (firstTag: string, secondTag: string) => {
      const first = parseAutoTeleopTag(firstTag);
      const second = parseAutoTeleopTag(secondTag);

      if (!first || !second) {
        return false;
      }

      return first.base === second.base && first.phase !== second.phase;
    },
    [parseAutoTeleopTag],
  );

  const dataScatterRows = React.useMemo(() => {
    if (!selectedDataXTag || !selectedDataYTag) {
      return [] as Array<{ x: number; y: number; team: string; matches: number }>;
    }

    const grouped = new Map<string, { xSum: number; xCount: number; ySum: number; yCount: number; matches: number }>();

    for (const entry of jsonEntries) {
      const x = extractNumericValue(entry, selectedDataXTag);
      const y = extractNumericValue(entry, selectedDataYTag);

      const teamValue = entry.team;
      const team = typeof teamValue === "string" ? teamValue.trim() : typeof teamValue === "number" ? String(teamValue) : "Unknown";
      if (!team) {
        continue;
      }

      const current = grouped.get(team) ?? { xSum: 0, xCount: 0, ySum: 0, yCount: 0, matches: 0 };
      current.matches += 1;

      if (x !== null) {
        current.xSum += x;
        current.xCount += 1;
      }

      if (y !== null) {
        current.ySum += y;
        current.yCount += 1;
      }

      grouped.set(team, current);
    }

    return Array.from(grouped.entries())
      .filter(([, stats]) => stats.xCount > 0 && stats.yCount > 0)
      .map(([team, stats]) => ({
        team,
        x: stats.xSum / stats.xCount,
        y: stats.ySum / stats.yCount,
        matches: stats.matches,
      }))
      .sort((left, right) => right.y - left.y);
  }, [extractNumericValue, jsonEntries, selectedDataXTag, selectedDataYTag]);

  const dataBarRows = React.useMemo(() => {
    if (!selectedDataYTag) {
      return [] as Array<{ team: string; primaryValue: number; secondaryValue: number; totalValue: number }>;
    }

    const grouped = new Map<string, { primarySum: number; primaryCount: number; secondarySum: number; secondaryCount: number }>();

    for (const entry of jsonEntries) {
      const primaryValue = extractNumericValue(entry, selectedDataYTag);
      const secondaryValue = selectedDataYTagSecondary ? extractNumericValue(entry, selectedDataYTagSecondary) : null;

      const teamValue = entry.team;
      const team = typeof teamValue === "string" ? teamValue.trim() : typeof teamValue === "number" ? String(teamValue) : "Unknown";
      if (!team) {
        continue;
      }

      const current = grouped.get(team) ?? { primarySum: 0, primaryCount: 0, secondarySum: 0, secondaryCount: 0 };

      if (primaryValue !== null) {
        current.primarySum += primaryValue;
        current.primaryCount += 1;
      }

      if (secondaryValue !== null) {
        current.secondarySum += secondaryValue;
        current.secondaryCount += 1;
      }

      grouped.set(team, current);
    }

    return Array.from(grouped.entries())
      .map(([team, stats]) => {
        const primaryAverage = stats.primaryCount > 0 ? stats.primarySum / stats.primaryCount : 0;
        const secondaryAverage = selectedDataYTagSecondary
          ? stats.secondaryCount > 0
            ? stats.secondarySum / stats.secondaryCount
            : 0
          : 0;

        return {
          team,
          primaryValue: primaryAverage,
          secondaryValue: secondaryAverage,
          totalValue: primaryAverage + secondaryAverage,
        };
      })
      .sort((left, right) => right.totalValue - left.totalValue);
  }, [extractNumericValue, jsonEntries, selectedDataYTag, selectedDataYTagSecondary]);

  const teamAverages = React.useMemo(() => {
    if (!statsTeam) {
      return [] as Array<{ tag: string; average: number }>;
    }

    const relevantEntries = jsonEntries.filter((entry) => {
      const value = entry.team;
      return typeof value === "string" ? value.trim() === statsTeam : typeof value === "number" ? String(value) === statsTeam : false;
    });

    const totals = new Map<string, { sum: number; count: number }>();
    const excludedTags = excludedDataTags;

    for (const entry of relevantEntries) {
      for (const [tag, value] of Object.entries(entry)) {
        if (excludedTags.has(tag)) {
          continue;
        }

        if (typeof value === "boolean") {
          continue;
        }

        let numericValue: number | null = null;

        if (typeof value === "number" && Number.isFinite(value)) {
          numericValue = value;
        } else if (typeof value === "string" && value.trim() !== "") {
          const parsed = Number(value);
          if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
            numericValue = parsed;
          }
        }

        if (numericValue === null) {
          continue;
        }

        const current = totals.get(tag) ?? { sum: 0, count: 0 };
        current.sum += numericValue;
        current.count += 1;
        totals.set(tag, current);
      }
    }

    return Array.from(totals.entries())
      .map(([tag, stats]) => ({
        tag,
        average: stats.count > 0 ? stats.sum / stats.count : 0,
      }))
      .sort((left, right) => left.tag.localeCompare(right.tag));
  }, [excludedDataTags, jsonEntries, statsTeam]);

  const selectedTeamMatchCount = React.useMemo(() => {
    if (!statsTeam) {
      return 0;
    }

    return jsonEntries.filter((entry) => {
      const value = entry.team;
      return typeof value === "string" ? value.trim() === statsTeam : typeof value === "number" ? String(value) === statsTeam : false;
    }).length;
  }, [jsonEntries, statsTeam]);

  const buildTeamSeriesByTag = React.useCallback(
    (team: string) => {
      const series = new Map<string, TeamSeriesPoint[]>();
      if (!team) {
        return series;
      }

      const relevantEntries = jsonEntries.filter((entry) => {
        const value = entry.team;
        return typeof value === "string" ? value.trim() === team : typeof value === "number" ? String(value) === team : false;
      });

      for (let index = 0; index < relevantEntries.length; index += 1) {
        const entry = relevantEntries[index];
        const rawMatch = entry.match;
        let matchNumber = index + 1;

        if (typeof rawMatch === "number" && Number.isFinite(rawMatch)) {
          matchNumber = rawMatch;
        } else if (typeof rawMatch === "string" && rawMatch.trim() !== "") {
          const parsedMatch = Number(rawMatch);
          if (!Number.isNaN(parsedMatch) && Number.isFinite(parsedMatch)) {
            matchNumber = parsedMatch;
          }
        }

        const scouterValue = entry.scouter;
        const scouterName = typeof scouterValue === "string" && scouterValue.trim() ? scouterValue.trim() : "Unknown";

        for (const [tag, value] of Object.entries(entry)) {
          if (excludedDataTags.has(tag) || typeof value === "boolean") {
            continue;
          }

          let numericValue: number | null = null;

          if (typeof value === "number" && Number.isFinite(value)) {
            numericValue = value;
          } else if (typeof value === "string" && value.trim() !== "") {
            const parsedValue = Number(value);
            if (!Number.isNaN(parsedValue) && Number.isFinite(parsedValue)) {
              numericValue = parsedValue;
            }
          }

          if (numericValue === null) {
            continue;
          }

          const points = series.get(tag) ?? [];
          points.push({ match: matchNumber, value: numericValue, scouter: scouterName });
          series.set(tag, points);
        }
      }

      for (const [tag, points] of series.entries()) {
        points.sort((left, right) => left.match - right.match);
        series.set(tag, points);
      }

      return series;
    },
    [excludedDataTags, jsonEntries],
  );

  const teamSeriesByTag = React.useMemo(() => {
    return buildTeamSeriesByTag(activeTeam);
  }, [activeTeam, buildTeamSeriesByTag]);

  const availableTeamTags = React.useMemo(() => {
    return Array.from(teamSeriesByTag.keys()).sort((left, right) => left.localeCompare(right));
  }, [teamSeriesByTag]);

  React.useEffect(() => {
    setTeamTagOrder((previous) => {
      const present = previous.filter((tag) => availableTeamTags.includes(tag));
      const additions = availableTeamTags.filter((tag) => !present.includes(tag));
      return [...present, ...additions];
    });

    setSelectedTeamTag((previous) => {
      if (previous && availableTeamTags.includes(previous)) {
        return previous;
      }
      return availableTeamTags[0] ?? "";
    });
  }, [availableTeamTags]);

  const orderedTeamTags = React.useMemo(() => {
    const seen = new Set<string>();
    const ordered: string[] = [];

    for (const tag of teamTagOrder) {
      if (availableTeamTags.includes(tag) && !seen.has(tag)) {
        seen.add(tag);
        ordered.push(tag);
      }
    }

    for (const tag of availableTeamTags) {
      if (!seen.has(tag)) {
        ordered.push(tag);
      }
    }

    return ordered;
  }, [availableTeamTags, teamTagOrder]);

  const selectedTeamSeries = React.useMemo(() => {
    if (!selectedTeamTag) {
      return [] as TeamSeriesPoint[];
    }

    return teamSeriesByTag.get(selectedTeamTag) ?? [];
  }, [selectedTeamTag, teamSeriesByTag]);

  const compareTeam = React.useMemo(() => compareTeamInput.trim(), [compareTeamInput]);

  const compareTeamSeriesByTag = React.useMemo(() => {
    if (!compareTeam || compareTeam === activeTeam) {
      return new Map<string, TeamSeriesPoint[]>();
    }
    return buildTeamSeriesByTag(compareTeam);
  }, [activeTeam, buildTeamSeriesByTag, compareTeam]);

  const selectedCompareSeries = React.useMemo(() => {
    if (!selectedTeamTag) {
      return [] as TeamSeriesPoint[];
    }
    return compareTeamSeriesByTag.get(selectedTeamTag) ?? [];
  }, [compareTeamSeriesByTag, selectedTeamTag]);

  const targetChartData = React.useMemo(() => {
    const byMatch = new Map<number, TeamChartPoint>();

    for (const point of selectedTeamSeries) {
      byMatch.set(point.match, {
        match: point.match,
        value: point.value,
        compareValue: null,
        scouter: point.scouter,
        compareScouter: "",
      });
    }

    for (const point of selectedCompareSeries) {
      const existing = byMatch.get(point.match);
      if (existing) {
        existing.compareValue = point.value;
        existing.compareScouter = point.scouter;
        byMatch.set(point.match, existing);
      } else {
        byMatch.set(point.match, {
          match: point.match,
          value: null,
          compareValue: point.value,
          scouter: "",
          compareScouter: point.scouter,
        });
      }
    }

    return Array.from(byMatch.values()).sort((left, right) => left.match - right.match);
  }, [selectedCompareSeries, selectedTeamSeries]);

  React.useEffect(() => {
    if (targetChartData.length === 0) {
      setAnimatedChartData([]);
      return;
    }

    const baseline = targetChartData.map((point) => ({
      match: point.match,
      value: typeof point.value === "number" ? 0 : null,
      compareValue: typeof point.compareValue === "number" ? 0 : null,
      scouter: point.scouter,
      compareScouter: point.compareScouter,
    }));
    setAnimatedChartData(baseline);

    const frame = window.requestAnimationFrame(() => {
      setAnimatedChartData(targetChartData);
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [targetChartData]);

  React.useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    if (isTeamGraphFullscreen || isDataGraphFullscreen) {
      document.body.style.overflow = "hidden";
    }

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isDataGraphFullscreen, isTeamGraphFullscreen]);

  React.useEffect(() => {
    if (dataGraphType === "bar") {
      setActiveDataAxis("y");
    }
  }, [dataGraphType]);

  React.useEffect(() => {
    if (!selectedDataYTagSecondary) {
      return;
    }

    if (!allNumericTags.includes(selectedDataYTagSecondary)) {
      setSelectedDataYTagSecondary("");
      return;
    }

    if (!isAutoTeleopPair(selectedDataYTag, selectedDataYTagSecondary)) {
      setSelectedDataYTagSecondary("");
    }
  }, [allNumericTags, isAutoTeleopPair, selectedDataYTag, selectedDataYTagSecondary]);

  const normalizedDataTeamSearch = React.useMemo(() => dataTeamSearch.trim().toLowerCase(), [dataTeamSearch]);

  const highlightedScatterRows = React.useMemo(() => {
    if (!normalizedDataTeamSearch) {
      return [] as typeof dataScatterRows;
    }
    return dataScatterRows.filter((row) => row.team.toLowerCase().includes(normalizedDataTeamSearch));
  }, [dataScatterRows, normalizedDataTeamSearch]);

  const regularScatterRows = React.useMemo(() => {
    if (!normalizedDataTeamSearch) {
      return dataScatterRows;
    }
    return dataScatterRows.filter((row) => !row.team.toLowerCase().includes(normalizedDataTeamSearch));
  }, [dataScatterRows, normalizedDataTeamSearch]);

  const highlightedBarTeams = React.useMemo(() => {
    if (!normalizedDataTeamSearch) {
      return new Set<string>();
    }
    return new Set(dataBarRows.filter((row) => row.team.toLowerCase().includes(normalizedDataTeamSearch)).map((row) => row.team));
  }, [dataBarRows, normalizedDataTeamSearch]);

  const foundScatterTeam = React.useMemo(() => {
    if (!normalizedDataTeamSearch) {
      return null;
    }
    return highlightedScatterRows[0] ?? null;
  }, [highlightedScatterRows, normalizedDataTeamSearch]);

  const foundBarTeamIndex = React.useMemo(() => {
    if (!normalizedDataTeamSearch) {
      return -1;
    }
    return dataBarRows.findIndex((row) => row.team.toLowerCase().includes(normalizedDataTeamSearch));
  }, [dataBarRows, normalizedDataTeamSearch]);

  const moveTeamTag = React.useCallback((fromTag: string, toTag: string) => {
    if (fromTag === toTag) {
      return;
    }

    setTeamTagOrder((previous) => {
      const next = [...previous];
      const fromIndex = next.indexOf(fromTag);
      const toIndex = next.indexOf(toTag);

      if (fromIndex < 0 || toIndex < 0) {
        return previous;
      }

      next.splice(fromIndex, 1);
      next.splice(toIndex, 0, fromTag);
      return next;
    });
  }, []);

  const displayedProjects = React.useMemo(() => {
    if (!workspace) {
      return [];
    }

    const term = search.trim().toLowerCase();
    if (!term) {
      return workspace.projects;
    }

    return workspace.projects.filter((project) => project.name.toLowerCase().includes(term));
  }, [search, workspace]);

  const navigateHome = React.useCallback(() => {
    window.location.hash = "#/";
  }, []);

  const navigateProject = React.useCallback((projectId: string) => {
    window.location.hash = buildProjectHash(projectId);
  }, []);

  const navigateTeam = React.useCallback((projectId: string, team: string) => {
    window.location.hash = buildTeamHash(projectId, team);
  }, []);

  const navigateViewer = React.useCallback((project?: WorkspaceProject) => {
    window.location.hash = buildViewerHash(project);
  }, []);

  const handleCreateProject = React.useCallback(async () => {
    const name = createProjectName.trim();
    if (!name) {
      setWorkspaceError("Project name is required.");
      return;
    }

    setIsCreatingProject(true);

    try {
      const project = await invoke<WorkspaceProject>("create_goonhq_project", { name });
      await refreshWorkspace();
      setIsCreateDialogOpen(false);
      window.location.hash = buildProjectHash(project.id);
    } catch (error) {
      setWorkspaceError(`Could not create project: ${String(error)}`);
    } finally {
      setIsCreatingProject(false);
    }
  }, [createProjectName, refreshWorkspace]);

  const viewerPath = route.kind === "viewer" ? selectedProject?.json_file_path ?? "" : "";

  if (route.kind === "viewer") {
    return (
      <div className="min-h-screen bg-slate-900 text-white">
        <header className="flex items-center justify-between border-b border-white/10 bg-slate-900 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="text-4xl font-black tracking-tight text-white">GoonHQ</div>
            <Button type="button" variant="secondary" size="sm" onClick={navigateHome}>
              <Home className="mr-2 h-4 w-4" />
              Home
            </Button>
            {selectedProject ? (
              <Button type="button" variant="outline" size="sm" onClick={() => navigateProject(selectedProject.id)}>
                <Folder className="mr-2 h-4 w-4" />
                {selectedProject.name}
              </Button>
            ) : null}
          </div>
          <div className="text-sm text-white/65">JSON Viewer</div>
        </header>

        <JsonViewerPage initialPath={viewerPath} projectId={selectedProject?.id ?? route.projectId} />
      </div>
    );
  }

  if (route.kind === "team") {
    return (
      <div className="min-h-screen bg-slate-900 text-white">
        <header className="flex items-center justify-between border-b border-white/10 bg-slate-900 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="text-4xl font-black tracking-tight text-white">GoonHQ</div>
            <Button type="button" variant="secondary" size="sm" onClick={navigateHome}>
              <Home className="mr-2 h-4 w-4" />
              Home
            </Button>
            {selectedProject ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setProjectSection("teams");
                  navigateProject(selectedProject.id);
                }}
              >
                <Folder className="mr-2 h-4 w-4" />
                {selectedProject.name}
              </Button>
            ) : null}
          </div>
          <div className="text-sm text-white/65">Team Details</div>
        </header>

        <main className="p-4 md:p-6">
          {!selectedProject ? (
            <div className="rounded-xl border border-white/10 bg-slate-900/40 px-4 py-8 text-sm text-white/70">Project not found.</div>
          ) : (
            <div
              className={`space-y-4 rounded-2xl border border-white/10 bg-slate-950/60 p-4 md:p-6 ${
                isTeamGraphFullscreen ? "" : "backdrop-blur"
              }`}
            >
              <h1 className="text-3xl font-semibold tracking-tight">
                Team <span className="text-white">{activeTeam}</span>
              </h1>
              <p className="text-white/75">
                Project: <span className="font-semibold text-white">{selectedProject.name}</span> • Matches: {selectedTeamMatchCount}
              </p>

              {isLoadingIndex ? (
                <div className="rounded-xl border border-white/10 bg-slate-900/50 px-4 py-6 text-sm text-white/70">Loading team stats...</div>
              ) : indexError ? (
                <p className="text-sm text-red-300">{indexError}</p>
              ) : teamAverages.length === 0 ? (
                <p className="text-sm text-white/60">No numeric tags available for averages.</p>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {teamAverages.map((item) => (
                    <div key={item.tag} className="rounded-lg border border-white/15 bg-slate-950/70 p-3">
                      <p className="text-xs uppercase tracking-wide text-white/55">{item.tag}</p>
                      <p className="mt-2 text-2xl font-semibold text-white">{item.average.toFixed(2)}</p>
                    </div>
                  ))}
                </div>
              )}

              <div className={isTeamGraphFullscreen ? "fixed inset-0 z-[200] overflow-y-auto bg-slate-950 p-4 md:p-6" : ""}>
                <div className="mb-3 flex items-center justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    className="border-white/20 bg-slate-900/60 text-white hover:bg-slate-800"
                    onClick={() => setIsTeamGraphFullscreen((current) => !current)}
                  >
                    {isTeamGraphFullscreen ? "Exit Full Screen" : "Full Screen"}
                  </Button>
                </div>

                <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
                <aside className="rounded-xl border border-white/10 bg-slate-900/50 p-3 xl:col-span-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-white/55">Data Tags</p>
                  <p className="mb-3 text-xs text-white/50">Click a tag to graph it. Drag to reorder.</p>

                  {orderedTeamTags.length === 0 ? (
                    <p className="text-sm text-white/60">No numeric tags available.</p>
                  ) : (
                    <div className="space-y-2">
                      {orderedTeamTags.map((tag) => {
                        const selected = selectedTeamTag === tag;
                        return (
                          <button
                            key={tag}
                            type="button"
                            draggable
                            onDragStart={() => setDraggingTeamTag(tag)}
                            onDragOver={(event) => {
                              event.preventDefault();
                            }}
                            onDrop={(event) => {
                              event.preventDefault();
                              if (draggingTeamTag) {
                                moveTeamTag(draggingTeamTag, tag);
                              }
                              setDraggingTeamTag(null);
                            }}
                            onDragEnd={() => setDraggingTeamTag(null)}
                            onClick={() => setSelectedTeamTag(tag)}
                            className={`w-full rounded-lg border px-3 py-2 text-left text-sm font-medium transition ${
                              selected
                                ? "border-blue-400/70 bg-blue-600/20 text-white"
                                : "border-white/15 bg-slate-900/70 text-white hover:border-blue-400/60 hover:bg-blue-600/20"
                            }`}
                          >
                            {tag}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </aside>

                <div className="rounded-xl border border-white/10 bg-slate-900/50 p-4 xl:col-span-9">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm text-white/75">
                        Match vs <span className="font-semibold text-white">{selectedTeamTag || "Tag"}</span>
                      </p>
                      <p className="text-xs text-white/50">X: Match • Y: Selected Tag Value</p>
                      {compareTeam && compareTeam !== activeTeam ? (
                        <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-white/70">
                          <div className="flex items-center gap-2">
                            <span className="inline-block h-2.5 w-2.5 rounded-full bg-blue-400" />
                            <span>Team {activeTeam}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-400" />
                            <span>Team {compareTeam}</span>
                          </div>
                        </div>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <p className="text-xs text-white/60">Compare team</p>
                      <Input
                        value={compareTeamInput}
                        onChange={(event) => setCompareTeamInput(event.currentTarget.value)}
                        placeholder="Team #"
                        className="h-9 w-32 border-white/10 bg-slate-900/80 text-white placeholder:text-white/35"
                      />
                    </div>
                  </div>

                  {selectedTeamTag && animatedChartData.length > 0 ? (
                    <div className={isTeamGraphFullscreen ? "h-[calc(100dvh-280px)] min-h-[260px] w-full" : "h-[420px] w-full"}>
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={animatedChartData} margin={{ top: 12, right: 20, left: 0, bottom: 8 }}>
                          <CartesianGrid stroke="rgba(255,255,255,0.12)" strokeDasharray="3 3" />
                          <XAxis
                            dataKey="match"
                            type="number"
                            domain={["dataMin", "dataMax"]}
                            tick={{ fill: "rgba(255,255,255,0.75)", fontSize: 12 }}
                            allowDecimals={false}
                          />
                          <YAxis
                            type="number"
                            domain={["auto", "auto"]}
                            tick={{ fill: "rgba(255,255,255,0.75)", fontSize: 12 }}
                            width={60}
                          />
                          <Tooltip
                            contentStyle={{
                              backgroundColor: "rgba(2,6,23,0.95)",
                              border: "1px solid rgba(255,255,255,0.15)",
                              borderRadius: "0.75rem",
                              color: "white",
                            }}
                            formatter={(value, name, item) => {
                              const numeric = typeof value === "number" ? value : Number(value);
                              const entry = item.payload as TeamChartPoint;
                              const tagLabel = name === "compareValue" ? `${selectedTeamTag} (Compare)` : selectedTeamTag;
                              const scouter = name === "compareValue" ? entry.compareScouter || "Unknown" : entry.scouter || "Unknown";
                              const valueLabel = Number.isFinite(numeric) ? numeric.toFixed(2) : String(value);
                              return [`${valueLabel} • Scouter: ${scouter}`, tagLabel];
                            }}
                            labelFormatter={(label) => `Match ${label}`}
                          />
                          <Line
                            type="linear"
                            dataKey="value"
                            connectNulls
                            stroke="#60a5fa"
                            strokeWidth={3}
                            dot={{ r: 3, fill: "#93c5fd", stroke: "#60a5fa" }}
                            activeDot={{ r: 5 }}
                            isAnimationActive
                            animationDuration={520}
                            animationEasing="ease-out"
                          />
                          {compareTeam && compareTeam !== activeTeam ? (
                            <Line
                              type="linear"
                              dataKey="compareValue"
                              connectNulls
                              stroke="#f59e0b"
                              strokeWidth={3}
                              dot={{ r: 3, fill: "#fbbf24", stroke: "#f59e0b" }}
                              activeDot={{ r: 5 }}
                              isAnimationActive
                              animationDuration={520}
                              animationEasing="ease-out"
                            />
                          ) : null}
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <div className={`${isTeamGraphFullscreen ? "h-[calc(100dvh-280px)] min-h-[260px]" : "h-[420px]"} flex items-center justify-center rounded-lg border border-white/10 bg-slate-950/50 text-sm text-white/60`}>
                      Select a tag to view the graph.
                    </div>
                  )}
                </div>
              </div>
              </div>
            </div>
          )}
        </main>
      </div>
    );
  }

  if (route.kind === "project") {
    return (
      <div className="min-h-screen bg-slate-900 text-white">
        <header className="flex items-center justify-between border-b border-white/10 bg-slate-900 px-6 py-4">
          <div className="text-4xl font-black tracking-tight text-white">GoonHQ</div>
          <div className="flex items-center gap-3">
            <Button type="button" className="h-10 rounded-xl bg-blue-600 px-5 text-white hover:bg-blue-500" onClick={() => setIsCreateDialogOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              New Project
            </Button>
            <Button type="button" variant="outline" className="h-10 rounded-xl border-white/20 bg-slate-900/60 px-5 text-white hover:bg-slate-800" onClick={() => void refreshWorkspace()}>
              <Upload className="mr-2 h-4 w-4" />
              Upload
            </Button>
          </div>
        </header>

        <main className="grid h-[calc(100vh-73px)] grid-cols-1 items-start gap-4 p-4 md:grid-cols-12">
          <aside className="flex h-full flex-col rounded-2xl border border-white/10 bg-slate-950/60 p-4 backdrop-blur md:col-span-3 xl:col-span-2">
            <button
              type="button"
              className={`flex items-center gap-2 rounded-xl px-3 py-2 text-left transition ${projectSection === "overview" ? "bg-blue-600/20 text-white" : "text-white/80 hover:bg-white/5"}`}
              onClick={() => setProjectSection("overview")}
            >
              <Home className="h-4 w-4" />
              Overview
            </button>
            <button
              type="button"
              className={`mt-1 flex items-center gap-2 rounded-xl px-3 py-2 text-left transition ${projectSection === "config" ? "bg-blue-600/20 text-white" : "text-white/80 hover:bg-white/5"}`}
              onClick={() => setProjectSection("config")}
            >
              <Settings className="h-4 w-4" />
              Config
            </button>
            <button
              type="button"
              className={`mt-1 flex items-center gap-2 rounded-xl px-3 py-2 text-left transition ${projectSection === "compare" ? "bg-blue-600/20 text-white" : "text-white/80 hover:bg-white/5"}`}
              onClick={() => setProjectSection("compare")}
            >
              <BarChart3 className="h-4 w-4" />
              Compare
            </button>
            <button
              type="button"
              className={`mt-1 flex items-center gap-2 rounded-xl px-3 py-2 text-left transition ${projectSection === "picklist" ? "bg-blue-600/20 text-white" : "text-white/80 hover:bg-white/5"}`}
              onClick={() => setProjectSection("picklist")}
            >
              <FileJson className="h-4 w-4" />
              Picklist
            </button>
            <button
              type="button"
              className={`mt-1 flex items-center gap-2 rounded-xl px-3 py-2 text-left transition ${projectSection === "scouts" ? "bg-blue-600/20 text-white" : "text-white/80 hover:bg-white/5"}`}
              onClick={() => setProjectSection("scouts")}
            >
              <Folder className="h-4 w-4" />
              Scouts
            </button>
            <button
              type="button"
              className={`mt-1 flex items-center gap-2 rounded-xl px-3 py-2 text-left transition ${projectSection === "teams" ? "bg-blue-600/20 text-white" : "text-white/80 hover:bg-white/5"}`}
              onClick={() => setProjectSection("teams")}
            >
              <Upload className="h-4 w-4" />
              Teams
            </button>
            <button
              type="button"
              className={`mt-1 flex items-center gap-2 rounded-xl px-3 py-2 text-left transition ${projectSection === "data" ? "bg-blue-600/20 text-white" : "text-white/80 hover:bg-white/5"}`}
              onClick={() => setProjectSection("data")}
            >
              <BarChart3 className="h-4 w-4" />
              Data
            </button>
          </aside>

          <section
            className={`h-full rounded-2xl border border-white/10 bg-slate-950/60 p-4 ${
              projectSection === "data" && isDataGraphFullscreen ? "" : "backdrop-blur"
            } md:col-span-9 xl:col-span-10 ${
              projectSection === "data" && isDataGraphFullscreen ? "overflow-hidden" : "overflow-auto"
            }`}
          >
            {!selectedProject ? (
              <div className="rounded-xl border border-white/10 bg-slate-900/40 px-4 py-8 text-sm text-white/70">
                Project not found.
              </div>
            ) : projectSection === "overview" ? (
              <div className="space-y-4">
                <h1 className="text-4xl font-semibold tracking-tight">{selectedProject.name}</h1>
                <p className="text-white/70">{fromUnixSecondsToUpdatedLabel(selectedProject.updated_at)}</p>
                <div className="rounded-xl border border-white/10 bg-slate-900/50 p-4">
                  <p className="text-sm text-white/80">Folder: {selectedProject.folder_path}</p>
                  <p className="mt-2 text-sm text-white/80">Scanner JSON: {selectedProject.json_file_path ?? "No JSON file yet"}</p>
                </div>
                <JsonViewerPage initialPath={selectedProject.json_file_path ?? ""} projectId={selectedProject.id} embedded />
              </div>
            ) : projectSection === "config" ? (
              <div className="space-y-4">
                <h1 className="text-3xl font-semibold tracking-tight">Config</h1>
                <p className="text-white/70">Project configuration tools will live here.</p>
              </div>
            ) : projectSection === "compare" ? (
              <div className="space-y-4">
                <h1 className="text-3xl font-semibold tracking-tight">Compare</h1>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  <div className="rounded-xl border border-white/10 bg-slate-900/60 p-4 text-sm text-white/80">Compare module: Coming soon</div>
                  <div className="rounded-xl border border-white/10 bg-slate-900/60 p-4 text-sm text-white/80">Project-to-project diff: Coming soon</div>
                  <div className="rounded-xl border border-white/10 bg-slate-900/60 p-4 text-sm text-white/80">Metrics sync: Coming soon</div>
                </div>
              </div>
            ) : projectSection === "picklist" ? (
              <div className="space-y-4">
                <h1 className="text-3xl font-semibold tracking-tight">Picklist</h1>
                <p className="text-white/70">Picklist tools and exports will live here.</p>
              </div>
            ) : projectSection === "scouts" ? (
              <div className="space-y-4">
                <h1 className="text-3xl font-semibold tracking-tight">Scouts</h1>
                <p className="text-white/70">Filter by `scouter` and select a scout.</p>

                <div className="relative max-w-xs">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/45" />
                  <Input
                    value={scoutSearch}
                    onChange={(event) => setScoutSearch(event.currentTarget.value)}
                    placeholder="Search scouts..."
                    className="h-10 border-white/10 bg-slate-900/80 pl-9 text-white placeholder:text-white/35"
                  />
                </div>

                {indexError ? <p className="text-sm text-red-300">{indexError}</p> : null}

                {isLoadingIndex ? (
                  <div className="rounded-xl border border-white/10 bg-slate-900/50 px-4 py-6 text-sm text-white/70">Loading scouts...</div>
                ) : filteredScoutNames.length === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-slate-900/50 px-4 py-6 text-sm text-white/70">No scouts found from the `scouter` field in this JSON.</div>
                ) : (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {filteredScoutNames.map((scout) => {
                      const selected = selectedScout === scout;
                      return (
                        <button
                          key={scout}
                          type="button"
                          onClick={() => setSelectedScout(scout)}
                          className={`rounded-lg border px-3 py-2 text-left text-sm font-medium transition ${
                            selected
                              ? "border-blue-400/70 bg-blue-600/20 text-white"
                              : "border-white/15 bg-slate-900/70 text-white hover:border-blue-400/60 hover:bg-blue-600/20"
                          }`}
                        >
                          {scout}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : projectSection === "data" ? (
              <div className="space-y-4">
                <h1 className="text-3xl font-semibold tracking-tight">Data</h1>
                <p className="text-white/70">Click X or Y axis, then click a tag to populate the graph using all teams and all matches.</p>

                {indexError ? <p className="text-sm text-red-300">{indexError}</p> : null}

                {isLoadingIndex ? (
                  <div className="rounded-xl border border-white/10 bg-slate-900/50 px-4 py-6 text-sm text-white/70">Loading data...</div>
                ) : allNumericTags.length === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-slate-900/50 px-4 py-6 text-sm text-white/70">No numeric tags available from this JSON.</div>
                ) : (
                  <div className={isDataGraphFullscreen ? "fixed inset-0 z-[200] overflow-y-auto bg-slate-950 p-4 md:p-6" : ""}>
                    <div className="mb-3 flex items-center justify-end">
                      <Button
                        type="button"
                        variant="outline"
                        className="border-white/20 bg-slate-900/60 text-white hover:bg-slate-800"
                        onClick={() => setIsDataGraphFullscreen((current) => !current)}
                      >
                        {isDataGraphFullscreen ? "Exit Full Screen" : "Full Screen"}
                      </Button>
                    </div>

                    <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
                      <aside className="rounded-xl border border-white/10 bg-slate-900/50 p-3 xl:col-span-3">
                        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-white/55">Data Tags</p>
                        <p className="mb-3 text-xs text-white/50">
                          {dataGraphType === "bar"
                            ? "Bar mode: select Y then optional Y2. Y2 must be matching auto/teleop pair."
                            : "Select axis (X/Y), then click a tag."}
                        </p>

                        <div className="space-y-2">
                          {allNumericTags.map((tag) => {
                            const isX = dataGraphType === "scatter" && selectedDataXTag === tag;
                            const isY = selectedDataYTag === tag;
                            const isY2 = dataGraphType === "bar" && selectedDataYTagSecondary === tag;
                            return (
                              <button
                                key={tag}
                                type="button"
                                onClick={() => {
                                  const axis = dataGraphType === "bar" ? (activeDataAxis === "y2" ? "y2" : "y") : (activeDataAxis ?? "x");
                                  if (axis === "x") {
                                    setSelectedDataXTag(tag);
                                    setDataTagSelectionError("");
                                  } else if (axis === "y") {
                                    setSelectedDataYTag(tag);
                                    if (selectedDataYTagSecondary && !isAutoTeleopPair(tag, selectedDataYTagSecondary)) {
                                      setSelectedDataYTagSecondary("");
                                    }
                                    setDataTagSelectionError("");
                                  } else {
                                    if (!selectedDataYTag) {
                                      setDataTagSelectionError("Select Y axis tag first before Y2.");
                                      return;
                                    }
                                    if (isAutoTeleopPair(selectedDataYTag, tag)) {
                                      setSelectedDataYTagSecondary(tag);
                                      setDataTagSelectionError("");
                                    } else {
                                      setDataTagSelectionError("Y2 must be the same metric with opposite auto/teleop prefix.");
                                    }
                                  }
                                }}
                                className={`w-full rounded-lg border px-3 py-2 text-left text-sm font-medium transition ${
                                  isX && isY
                                    ? "border-violet-400/70 bg-violet-600/20 text-white"
                                    : isX
                                      ? "border-blue-400/70 bg-blue-600/20 text-white"
                                      : isY2
                                        ? "border-emerald-400/70 bg-emerald-600/20 text-white"
                                      : isY
                                        ? "border-amber-400/70 bg-amber-600/20 text-white"
                                        : "border-white/15 bg-slate-900/70 text-white hover:border-blue-400/60 hover:bg-blue-600/20"
                                }`}
                              >
                                {tag}
                              </button>
                            );
                          })}
                        </div>
                      </aside>

                      <div className="rounded-xl border border-white/10 bg-slate-900/50 p-4 xl:col-span-9">
                        <div className={`mb-3 grid grid-cols-1 gap-3 ${dataGraphType === "bar" ? "md:grid-cols-3" : "md:grid-cols-3"}`}>
                          {dataGraphType === "scatter" ? (
                            <button
                              type="button"
                              onClick={() => setActiveDataAxis("x")}
                              className={`rounded-lg border px-3 py-2 text-left ${
                                activeDataAxis === "x"
                                  ? "border-blue-400/70 bg-blue-600/20"
                                  : "border-dashed border-white/25 bg-slate-950/60"
                              }`}
                            >
                              <p className="text-xs text-white/55">X Axis</p>
                              <p className="mt-1 text-sm font-semibold text-white">{selectedDataXTag || "Click then select tag"}</p>
                            </button>
                          ) : null}

                          <button
                            type="button"
                            onClick={() => setActiveDataAxis("y")}
                            className={`rounded-lg border px-3 py-2 text-left ${
                              activeDataAxis === "y"
                                ? "border-amber-400/70 bg-amber-600/20"
                                : "border-dashed border-white/25 bg-slate-950/60"
                            }`}
                          >
                            <p className="text-xs text-white/55">Y Axis</p>
                            <p className="mt-1 text-sm font-semibold text-white">{selectedDataYTag || "Click then select tag"}</p>
                          </button>

                          {dataGraphType === "bar" ? (
                            <button
                              type="button"
                              onClick={() => setActiveDataAxis("y2")}
                              className={`rounded-lg border px-3 py-2 text-left ${
                                activeDataAxis === "y2"
                                  ? "border-emerald-400/70 bg-emerald-600/20"
                                  : "border-dashed border-white/25 bg-slate-950/60"
                              }`}
                            >
                              <p className="text-xs text-white/55">Y2 Axis (optional)</p>
                              <p className="mt-1 text-sm font-semibold text-white">{selectedDataYTagSecondary || "Click then select auto/teleop pair"}</p>
                            </button>
                          ) : null}

                          <div className="flex items-end gap-2">
                            <Button
                              type="button"
                              variant={dataGraphType === "scatter" ? "default" : "outline"}
                              className={dataGraphType === "scatter" ? "bg-blue-600 text-white hover:bg-blue-500" : "border-white/20 bg-slate-900/60 text-white hover:bg-slate-800"}
                              onClick={() => setDataGraphType("scatter")}
                            >
                              Scatter
                            </Button>
                            <Button
                              type="button"
                              variant={dataGraphType === "bar" ? "default" : "outline"}
                              className={dataGraphType === "bar" ? "bg-blue-600 text-white hover:bg-blue-500" : "border-white/20 bg-slate-900/60 text-white hover:bg-slate-800"}
                              onClick={() => {
                                setDataGraphType("bar");
                                setDataTagSelectionError("");
                              }}
                            >
                              Bar
                            </Button>
                          </div>
                        </div>

                        {dataTagSelectionError ? <p className="mb-2 text-xs text-amber-300">{dataTagSelectionError}</p> : null}

                        <div className="mb-3 flex items-center gap-2">
                          <Search className="h-4 w-4 text-white/55" />
                          <Input
                            value={dataTeamSearch}
                            onChange={(event) => setDataTeamSearch(event.currentTarget.value)}
                            placeholder="Search team to highlight..."
                            className="h-9 max-w-xs border-white/10 bg-slate-900/80 text-white placeholder:text-white/35"
                          />
                        </div>

                        {normalizedDataTeamSearch ? (
                          <p className="mb-2 text-xs text-white/70">
                            {dataGraphType === "scatter"
                              ? foundScatterTeam
                                ? `Highlighted Team ${foundScatterTeam.team} at X ${foundScatterTeam.x.toFixed(2)}, Y ${foundScatterTeam.y.toFixed(2)}.`
                                : "No matching team found in scatter data."
                              : foundBarTeamIndex >= 0
                                ? `Highlighted Team ${dataBarRows[foundBarTeamIndex].team} at rank ${foundBarTeamIndex + 1}.`
                                : "No matching team found in bar data."}
                          </p>
                        ) : null}

                        <p className="mb-3 text-xs text-white/55">
                          {dataGraphType === "scatter"
                            ? "Scatter plot is sorted by Y value (best to worst) across all teams and matches."
                            : "Bar graph ranks teams from best to worst by total score (Y + Y2 when selected)."}
                        </p>

                        <div className={isDataGraphFullscreen ? "h-[calc(100dvh-280px)] min-h-[280px] w-full" : "h-[460px] w-full"}>
                          <ResponsiveContainer width="100%" height="100%">
                            {dataGraphType === "scatter" ? (
                              <ScatterChart margin={{ top: 12, right: 20, left: 10, bottom: 14 }}>
                                <CartesianGrid stroke="rgba(255,255,255,0.12)" strokeDasharray="3 3" />
                                <XAxis
                                  type="number"
                                  dataKey="x"
                                  name={selectedDataXTag || "x"}
                                  domain={["auto", "auto"]}
                                  tick={{ fill: "rgba(255,255,255,0.75)", fontSize: 12 }}
                                />
                                <YAxis
                                  type="number"
                                  dataKey="y"
                                  name={selectedDataYTag || "y"}
                                  domain={["auto", "auto"]}
                                  tick={{ fill: "rgba(255,255,255,0.75)", fontSize: 12 }}
                                  width={70}
                                />
                                <Tooltip
                                  contentStyle={{
                                    backgroundColor: "rgba(2,6,23,0.95)",
                                    border: "1px solid rgba(255,255,255,0.15)",
                                    borderRadius: "0.75rem",
                                    color: "white",
                                  }}
                                  formatter={(value, name, item) => {
                                    const row = item.payload as { team: string; matches: number };
                                    const numeric = typeof value === "number" ? value : Number(value);
                                    const axisKey = String(item.dataKey ?? name);
                                    const label = axisKey === "x" ? selectedDataXTag : selectedDataYTag;
                                    return [
                                      `${Number.isFinite(numeric) ? numeric.toFixed(2) : String(value)} • Team ${row.team} • Matches ${row.matches}`,
                                      label || String(name),
                                    ];
                                  }}
                                />
                                <Scatter data={regularScatterRows} fill="#60a5fa">
                                  <LabelList dataKey="team" position="bottom" fill="rgba(255,255,255,0.72)" fontSize={11} />
                                </Scatter>
                                {highlightedScatterRows.length > 0 ? (
                                  <Scatter data={highlightedScatterRows} fill="#f59e0b">
                                    <LabelList dataKey="team" position="bottom" fill="rgba(251,191,36,0.95)" fontSize={12} fontWeight={700} />
                                  </Scatter>
                                ) : null}
                              </ScatterChart>
                            ) : (
                              <BarChart data={dataBarRows} margin={{ top: 12, right: 20, left: 10, bottom: 70 }}>
                                <CartesianGrid stroke="rgba(255,255,255,0.12)" strokeDasharray="3 3" />
                                <XAxis
                                  dataKey="team"
                                  interval={0}
                                  angle={-35}
                                  textAnchor="end"
                                  height={70}
                                  tick={{ fill: "rgba(255,255,255,0.75)", fontSize: 11 }}
                                />
                                <YAxis
                                  domain={["auto", "auto"]}
                                  tick={{ fill: "rgba(255,255,255,0.75)", fontSize: 12 }}
                                  width={70}
                                />
                                <Tooltip
                                  contentStyle={{
                                    backgroundColor: "rgba(2,6,23,0.95)",
                                    border: "1px solid rgba(255,255,255,0.15)",
                                    borderRadius: "0.75rem",
                                    color: "white",
                                  }}
                                  formatter={(value, name, item) => {
                                    const numeric = typeof value === "number" ? value : Number(value);
                                    const labelName = name === "secondaryValue" ? (selectedDataYTagSecondary || "Y2") : selectedDataYTag;
                                    const row = item.payload as { totalValue: number };
                                    return [
                                      `${Number.isFinite(numeric) ? numeric.toFixed(2) : String(value)} • Total ${row.totalValue.toFixed(2)}`,
                                      `${labelName} (avg)`,
                                    ];
                                  }}
                                  labelFormatter={(label) => `Team ${label}`}
                                />
                                <Bar dataKey="primaryValue" stackId="score" radius={[0, 0, 0, 0]} name={selectedDataYTag || "Y"}>
                                  {dataBarRows.map((row) => (
                                    <Cell key={`primary-${row.team}`} fill={highlightedBarTeams.has(row.team) ? "#93c5fd" : "#60a5fa"} />
                                  ))}
                                </Bar>
                                {selectedDataYTagSecondary ? (
                                  <Bar dataKey="secondaryValue" stackId="score" radius={[6, 6, 0, 0]} name={selectedDataYTagSecondary}>
                                    {dataBarRows.map((row) => (
                                      <Cell key={`secondary-${row.team}`} fill={highlightedBarTeams.has(row.team) ? "#facc15" : "#f59e0b"} />
                                    ))}
                                  </Bar>
                                ) : null}
                              </BarChart>
                            )}
                          </ResponsiveContainer>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <h1 className="text-3xl font-semibold tracking-tight">Teams</h1>
                <p className="text-white/70">Filter by the `team` tag and select a team number.</p>

                <div className="relative max-w-xs">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/45" />
                  <Input
                    value={teamSearch}
                    onChange={(event) => setTeamSearch(event.currentTarget.value)}
                    placeholder="Search teams..."
                    className="h-10 border-white/10 bg-slate-900/80 pl-9 text-white placeholder:text-white/35"
                  />
                </div>

                {indexError ? <p className="text-sm text-red-300">{indexError}</p> : null}

                {isLoadingIndex ? (
                  <div className="rounded-xl border border-white/10 bg-slate-900/50 px-4 py-6 text-sm text-white/70">Loading teams...</div>
                ) : filteredTeamNumbers.length === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-slate-900/50 px-4 py-6 text-sm text-white/70">No teams found from the `team` field in this JSON.</div>
                ) : (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
                    {filteredTeamNumbers.map((team) => {
                      const selected = selectedTeam === team;
                      return (
                        <button
                          key={team}
                          type="button"
                          onClick={() => setSelectedTeam(team)}
                          onDoubleClick={() => navigateTeam(selectedProject.id, team)}
                          className={`rounded-lg border px-3 py-2 text-center text-sm font-medium transition ${
                            selected
                              ? "border-blue-400/70 bg-blue-600/20 text-white"
                              : "border-white/15 bg-slate-900/70 text-white hover:border-blue-400/60 hover:bg-blue-600/20"
                          }`}
                        >
                          {team}
                        </button>
                      );
                    })}
                  </div>
                )}

                {selectedTeam ? (
                  <div className="space-y-3 rounded-xl border border-white/10 bg-slate-900/50 p-4">
                    <p className="text-sm text-white/75">
                      Team <span className="font-semibold text-white">{selectedTeam}</span> • Matches: {selectedTeamMatchCount}
                    </p>

                    {teamAverages.length === 0 ? (
                      <p className="text-sm text-white/60">No numeric tags available for averages.</p>
                    ) : (
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {teamAverages.map((item) => (
                          <div key={item.tag} className="rounded-lg border border-white/15 bg-slate-950/70 p-3">
                            <p className="text-xs uppercase tracking-wide text-white/55">{item.tag}</p>
                            <p className="mt-2 text-2xl font-semibold text-white">{item.average.toFixed(2)}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            )}
          </section>
        </main>

        <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
          <DialogContent className="border-white/10 bg-slate-950 text-white sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Create Project</DialogTitle>
              <DialogDescription className="text-white/65">This creates a new folder under GoonHQMain/projects.</DialogDescription>
            </DialogHeader>
            <Input value={createProjectName} onChange={(event) => setCreateProjectName(event.target.value)} className="h-10 border-white/10 bg-slate-900/80 text-white placeholder:text-white/35" />
            <DialogFooter>
              <Button type="button" variant="outline" className="border-white/20 bg-slate-900/60 text-white hover:bg-slate-800" onClick={() => setIsCreateDialogOpen(false)} disabled={isCreatingProject}>
                Cancel
              </Button>
              <Button type="button" className="bg-blue-600 text-white hover:bg-blue-500" onClick={() => void handleCreateProject()} disabled={isCreatingProject}>
                {isCreatingProject ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <header className="flex items-center justify-between border-b border-white/10 bg-slate-900 px-6 py-4">
        <div className="text-4xl font-black tracking-tight text-white">GoonHQ</div>
        <div className="flex items-center gap-3">
          <Button type="button" className="h-10 rounded-xl bg-blue-600 px-5 text-white hover:bg-blue-500" onClick={() => setIsCreateDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New Project
          </Button>
          <Button type="button" variant="outline" className="h-10 rounded-xl border-white/20 bg-slate-900/60 px-5 text-white hover:bg-slate-800" onClick={() => void refreshWorkspace()}>
            <Upload className="mr-2 h-4 w-4" />
            Upload
          </Button>
        </div>
      </header>

      <main className="grid h-[calc(100vh-73px)] grid-cols-1 items-start gap-4 p-4 md:grid-cols-12">
        <aside className="flex h-full flex-col rounded-2xl border border-white/10 bg-slate-950/60 p-4 backdrop-blur md:col-span-3 xl:col-span-2">
          <div className="relative mb-5">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/45" />
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search projects..." className="h-10 border-white/10 bg-slate-900/80 pl-9 text-white placeholder:text-white/35" />
          </div>

          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-white/55">Projects</p>
          <div className="rounded-xl border border-white/10 bg-slate-900/40 px-3 py-2 text-sm text-white/70">Total Projects: {workspace?.projects.length ?? 0}</div>

          <div className="mt-auto pt-6">
            <Button type="button" variant="outline" className="w-full justify-start border-white/20 bg-slate-900/60 text-white hover:bg-slate-800" onClick={() => navigateViewer()}>
              <FileJson className="mr-2 h-4 w-4" />
              Open JSON Viewer
            </Button>
          </div>
        </aside>

        <section className="h-full overflow-auto rounded-2xl border border-white/10 bg-slate-950/60 p-4 backdrop-blur md:col-span-9 xl:col-span-10">
          <div className="mb-4 flex items-center justify-between gap-4">
            <h1 className="text-4xl font-semibold tracking-tight">My Projects</h1>
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/45" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search..." className="h-10 border-white/10 bg-slate-900/80 pl-9 text-white placeholder:text-white/35" />
            </div>
          </div>

          {workspace?.root_path ? <p className="mb-2 text-xs text-white/45">Workspace root: {workspace.root_path}</p> : null}
          {workspaceError ? <p className="mb-2 text-sm text-red-300">{workspaceError}</p> : null}

          {isLoadingWorkspace ? (
            <div className="rounded-xl border border-white/10 bg-slate-900/40 px-4 py-8 text-sm text-white/70">Loading projects...</div>
          ) : displayedProjects.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-slate-900/40 px-4 py-8 text-sm text-white/70">No projects found in GoonHQMain/projects.</div>
          ) : (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              {displayedProjects.map((project) => (
                <article key={project.id} className="overflow-hidden rounded-2xl border border-white/10 bg-slate-950/70 transition hover:border-blue-400/45">
                  <div className="h-40 w-full border-b border-white/10" style={{ background: cardGradient }} />
                  <button type="button" className="w-full p-4 text-left" onClick={() => navigateProject(project.id)}>
                    <h2 className="text-3xl font-semibold leading-tight">{project.name}</h2>
                    <p className="mt-2 text-base text-white/65">{fromUnixSecondsToUpdatedLabel(project.updated_at)}</p>
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>

      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="border-white/10 bg-slate-950 text-white sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create Project</DialogTitle>
            <DialogDescription className="text-white/65">This creates a new folder under GoonHQMain/projects.</DialogDescription>
          </DialogHeader>
          <Input value={createProjectName} onChange={(event) => setCreateProjectName(event.target.value)} className="h-10 border-white/10 bg-slate-900/80 text-white placeholder:text-white/35" />
          <DialogFooter>
            <Button type="button" variant="outline" className="border-white/20 bg-slate-900/60 text-white hover:bg-slate-800" onClick={() => setIsCreateDialogOpen(false)} disabled={isCreatingProject}>
              Cancel
            </Button>
            <Button type="button" className="bg-blue-600 text-white hover:bg-blue-500" onClick={() => void handleCreateProject()} disabled={isCreatingProject}>
              {isCreatingProject ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default App;
