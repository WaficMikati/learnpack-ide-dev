import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import useStore from "../../../utils/store";
import SimpleButton from "../../mockups/SimpleButton";
import toast from "react-hot-toast";
import {
  getGithubStatus,
  createGithubRepo,
  checkGithubChanges,
  pullFromGithub,
  pushToGithub,
  unlinkGithub,
  relinkGithub,
  resetGithubSync,
  syncAllTranslations,
} from "../../../utils/creator";
import { Loader } from "../../composites/Loader/Loader";
import { Icon } from "@/components/Icon";
import { getSlugFromPath, DEV_MODE } from "../../../utils/lib";
import CreatorSocket from "../../../managers/creatorSocket";

type CheckChangesResponse = {
  hasChanges: boolean;
  repoNotFound?: boolean;
  syncStateBroken?: boolean;
  currentSHA?: string;
  lastSyncSHA?: string;
  syncableChanges?: {
    lessons: Array<{
      slug: string;
      files: Array<{ filename: string; status: string }>;
    }>;
    assets: Array<{ filename: string; status: string }>;
    totalFiles: number;
  };
  skippedChanges?: {
    files: Array<{ filename: string; status: string; reason?: string }>;
    totalFiles: number;
  };
};

const buttonClass =
  "w-100 text-small text-yellow-800 bg-yellow-100 hover:bg-yellow-200 padding-small rounded";

const getRequestErrorMessage = (err: unknown, fallback: string): string => {
  if (axios.isAxiosError(err)) {
    const responseData = err.response?.data as { message?: string } | undefined;
    if (typeof responseData?.message === "string" && responseData.message) {
      return responseData.message;
    }
  }

  if (err instanceof Error && err.message) {
    return err.message;
  }

  return fallback;
};

export function GitHubActions() {
  const { token, configObject, fetchReadme, exercises } = useStore((state) => ({
    token: state.token,
    configObject: state.configObject,
    fetchReadme: state.fetchReadme,
    exercises: state.exercises,
  }));

  const [status, setStatus] = useState<{
    configured: boolean;
    linked: boolean;
    repository: string | null;
    pathPrefix: string | null;
    defaultBranch: string | null;
    repoNotFound: boolean;
  } | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [changes, setChanges] = useState<CheckChangesResponse | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showUnlinkModal, setShowUnlinkModal] = useState(false);
  const [showRelinkInput, setShowRelinkInput] = useState(false);
  const [relinkUrl, setRelinkUrl] = useState("");
  const [translateDirection, setTranslateDirection] = useState<
    "en-es" | "es-en"
  >("en-es");
  const [translateProgress, setTranslateProgress] = useState<{
    completed: number;
    total: number;
  } | null>(null);
  const translateToastRef = useRef<string | null>(null);
  const translateTargetRef = useRef<string>("ES");

  const courseSlug =
    configObject?.config?.slug || getSlugFromPath() || "";

  // The batch translate feature is only offered for courses whose languages
  // are exactly {en, es}. Any other language set disables it (safeguard).
  const enEsOnly = useMemo(() => {
    const langs = new Set<string>();
    (exercises || []).forEach((ex) =>
      Object.keys(ex.translations || {}).forEach((code) =>
        langs.add(code === "us" ? "en" : code)
      )
    );
    return langs.size === 2 && langs.has("en") && langs.has("es");
  }, [exercises]);

  const fetchStatus = async () => {
    if (!courseSlug) return;
    setStatusLoading(true);
    try {
      const data = await getGithubStatus(courseSlug);
      const repoNotFound = data.repoNotFound ?? false;
      setStatus({
        configured: data.configured ?? false,
        linked: data.linked ?? false,
        repository: data.repository ?? null,
        pathPrefix: data.pathPrefix ?? null,
        defaultBranch: data.defaultBranch ?? null,
        repoNotFound,
      });
      if (repoNotFound) setShowUnlinkModal(true);
    } catch {
      setStatus({
        configured: false,
        linked: false,
        repository: null,
        pathPrefix: null,
        defaultBranch: null,
      });
    } finally {
      setStatusLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, [courseSlug]);

  // Live progress channel for the batch "Translate all lessons" action.
  useEffect(() => {
    if (!courseSlug) return;
    const sock = new CreatorSocket(DEV_MODE ? "http://localhost:3000" : "");
    sock.connect();
    sock.emit("register", { courseSlug });

    const onProgress = (data: { completed: number; total: number }) => {
      setTranslateProgress({ completed: data.completed, total: data.total });
      if (translateToastRef.current) {
        toast.loading(
          `Translating ${data.completed}/${data.total} → ${translateTargetRef.current}…`,
          { id: translateToastRef.current }
        );
      }
    };

    const onCompleted = (data: {
      translated: number;
      failed: number;
      inSync: number;
    }) => {
      if (translateToastRef.current) {
        const parts = [`${data.translated} translated`];
        if (data.failed) parts.push(`${data.failed} failed`);
        if (data.inSync) parts.push(`${data.inSync} in sync`);
        const msg = parts.join(", ");
        if (data.failed) {
          toast.error(msg, { id: translateToastRef.current });
        } else {
          toast.success(msg, { id: translateToastRef.current });
        }
        translateToastRef.current = null;
      }
      setTranslateProgress(null);
      setActionLoading(null);
      fetchReadme();
    };

    const onError = (data: { error: string }) => {
      if (translateToastRef.current) {
        toast.error(data.error || "Translation failed", {
          id: translateToastRef.current,
        });
        translateToastRef.current = null;
      }
      setTranslateProgress(null);
      setActionLoading(null);
    };

    sock.on("sync-all-progress", onProgress);
    sock.on("sync-all-completed", onCompleted);
    sock.on("sync-all-error", onError);

    return () => {
      sock.off("sync-all-progress", onProgress);
      sock.off("sync-all-completed", onCompleted);
      sock.off("sync-all-error", onError);
      sock.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseSlug]);

  const handleTranslateAll = async () => {
    if (!courseSlug || !token || !enEsOnly || actionLoading) return;
    const sourceLanguage = translateDirection === "en-es" ? "en" : "es";
    translateTargetRef.current = translateDirection === "en-es" ? "ES" : "EN";
    setActionLoading("translate");
    setTranslateProgress(null);
    const toastId = toast.loading("Scanning lessons for changes...");
    translateToastRef.current = toastId;
    try {
      const res = await syncAllTranslations(courseSlug, sourceLanguage, token);
      const total = res?.total ?? 0;
      const inSync = res?.inSync ?? 0;
      if (total === 0) {
        toast.success(
          `All lessons already in sync${inSync ? ` (${inSync} skipped)` : ""}`,
          { id: toastId }
        );
        translateToastRef.current = null;
        setActionLoading(null);
        return;
      }
      // Hand off to the socket handlers for live progress + completion.
      setTranslateProgress({ completed: 0, total });
      toast.loading(
        `Translating 0/${total} → ${translateTargetRef.current}…`,
        { id: toastId }
      );
    } catch (err) {
      const msg = getRequestErrorMessage(err, "Failed to start translation");
      toast.error(msg, { id: toastId });
      translateToastRef.current = null;
      setActionLoading(null);
    }
  };

  const promptUnlinkIfRepoMissing = async (
    isMissing: boolean | undefined,
    toastId: string
  ): Promise<boolean> => {
    if (!isMissing) return false;
    toast.dismiss(toastId);
    setShowUnlinkModal(true);
    return true;
  };

  const handleUnlink = async () => {
    setShowUnlinkModal(false);
    const toastId = toast.loading("Unlinking repository...");
    try {
      await unlinkGithub(courseSlug);
      setChanges(null);
      await fetchStatus();
      toast.success("Repository unlinked", { id: toastId });
    } catch (err) {
      const msg = getRequestErrorMessage(err, "Failed to unlink repository");
      toast.error(msg, { id: toastId });
    }
  };

  const handleRelink = async () => {
    if (!relinkUrl.trim()) return;
    const toastId = toast.loading("Relinking repository...");
    try {
      await relinkGithub(courseSlug, relinkUrl.trim());
      setShowUnlinkModal(false);
      setShowRelinkInput(false);
      setRelinkUrl("");
      setChanges(null);
      await fetchStatus();
      toast.success("Repository relinked", { id: toastId });
    } catch (err) {
      const msg = getRequestErrorMessage(err, "Failed to relink repository");
      toast.error(msg, { id: toastId });
    }
  };

  const promptResetSyncIfBroken = async (
    isBroken: boolean | undefined,
    currentSHA: string | undefined,
    toastId: string
  ): Promise<boolean> => {
    if (!isBroken || !currentSHA) return false;
    toast.dismiss(toastId);
    if (
      window.confirm(
        "Sync state is out of date — the repo's history was rewritten (force-push or rebase). Reset tracking to the current head? Your bucket content won't change."
      )
    ) {
      await resetGithubSync(courseSlug, currentSHA);
      setChanges(null);
      await fetchStatus();
      toast.success("Sync state reset");
    }
    return true;
  };

  const handleCreateRepo = async () => {
    if (!courseSlug || !token) {
      toast.error("Course slug or token not available");
      return;
    }
    setActionLoading("create");
    const toastId = toast.loading("Creating GitHub repository...");
    try {
      await createGithubRepo(courseSlug, courseSlug, true, token);
      toast.success("Repository created successfully", { id: toastId });
      setChanges(null);
      await fetchStatus();
    } catch (err) {
      const msg = getRequestErrorMessage(err, "Failed to create repository");
      toast.error(msg, { id: toastId });
    } finally {
      setActionLoading(null);
    }
  };

  const handleCheckChanges = async () => {
    if (!courseSlug) return;
    setActionLoading("check");
    const toastId = toast.loading("Checking for changes...");
    try {
      const data = await checkGithubChanges(courseSlug);
      if (await promptUnlinkIfRepoMissing(data.repoNotFound, toastId)) return;
      if (
        await promptResetSyncIfBroken(
          data.syncStateBroken,
          data.currentSHA,
          toastId
        )
      )
        return;
      setChanges(data);
      if (!data.hasChanges) {
        toast.success("No changes in GitHub", { id: toastId });
      } else {
        toast.success(
          `Found ${data.syncableChanges?.totalFiles ?? 0} syncable file(s)`,
          { id: toastId }
        );
      }
    } catch (err) {
      const msg = getRequestErrorMessage(err, "Failed to check changes");
      toast.error(msg, { id: toastId });
    } finally {
      setActionLoading(null);
    }
  };

  const handlePull = async () => {
    if (!courseSlug || !changes?.currentSHA) return;
    setActionLoading("pull");
    const toastId = toast.loading("Pulling from GitHub...");
    try {
      const result = await pullFromGithub(courseSlug, changes.currentSHA);
      if (await promptUnlinkIfRepoMissing(result?.repoNotFound, toastId)) return;
      if (
        await promptResetSyncIfBroken(
          result?.syncStateBroken,
          result?.currentSHA,
          toastId
        )
      )
        return;
      toast.success(
        `Synced ${result.syncedFiles ?? 0} file(s), ${result.removedFiles ?? 0} removed`,
        { id: toastId }
      );
      setChanges(null);
      await fetchStatus();
      await fetchReadme();
    } catch (err) {
      const msg = getRequestErrorMessage(err, "Failed to pull from GitHub");
      toast.error(msg, { id: toastId });
    } finally {
      setActionLoading(null);
    }
  };

  const handlePush = async () => {
    if (!courseSlug) return;
    setActionLoading("push");
    const toastId = toast.loading("Pushing to GitHub...");
    try {
      const result = await pushToGithub(courseSlug);
      if (await promptUnlinkIfRepoMissing(result?.repoNotFound, toastId)) return;
      toast.success(
        `Pushed ${result.totalFiles ?? 0} file(s) to GitHub`,
        { id: toastId }
      );
      setChanges(null);
      await fetchStatus();
    } catch (err) {
      const msg = getRequestErrorMessage(err, "Failed to push to GitHub");
      toast.error(msg, { id: toastId });
    } finally {
      setActionLoading(null);
    }
  };

  if (!courseSlug) return null;

  if (showUnlinkModal) {
    return (
      <div className="flex-y gap-small padding-small">
        <p className="text-small text-yellow-800">
          The linked repository was not found and may have been deleted.
        </p>
        {showRelinkInput ? (
          <div className="flex-y gap-small">
            <input
              className="text-small padding-small rounded border border-yellow-300 bg-yellow-50"
              placeholder="https://github.com/user/repo"
              value={relinkUrl}
              onChange={e => setRelinkUrl(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleRelink()}
              autoFocus
            />
            <SimpleButton
              extraClass={buttonClass}
              svg={<Icon name="Link" size={16} />}
              text="Confirm Relink"
              action={handleRelink}
              disabled={!relinkUrl.trim()}
            />
            <SimpleButton
              extraClass={buttonClass}
              svg={<Icon name="ChevronLeft" size={16} />}
              text="Back"
              action={() => setShowRelinkInput(false)}
            />
          </div>
        ) : (
          <div className="flex-y gap-small">
            <SimpleButton
              extraClass={buttonClass}
              svg={<Icon name="Link" size={16} />}
              text="Relink"
              action={() => setShowRelinkInput(true)}
            />
            <SimpleButton
              extraClass={buttonClass}
              svg={<Icon name="Trash2" size={16} />}
              text="Unlink"
              action={handleUnlink}
            />
            <SimpleButton
              extraClass={buttonClass}
              svg={<Icon name="X" size={16} />}
              text="Cancel"
              action={() => setShowUnlinkModal(false)}
            />
          </div>
        )}
      </div>
    );
  }

  if (statusLoading) {
    return (
      <div className="flex-x gap-small align-center padding-small">
        <Loader color="gray" size="sm" />
        <span className="text-small">Verificando estado de GitHub...</span>
      </div>
    );
  }

  if (!status?.configured) {
    return (
      <div className="padding-small text-small text-yellow-800">
        Configura GITHUB_TOKEN y GITHUB_USERNAME en .env de learnpack-cli
      </div>
    );
  }

  if (!status?.linked) {
    return (
      <div className="flex-y gap-small padding-small">
        <SimpleButton
          extraClass={buttonClass}
          svg={<Icon name="GitBranch" size={16} />}
          text="Crear repo en GitHub"
          action={handleCreateRepo}
          disabled={!!actionLoading}
        />
      </div>
    );
  }

  return (
    <div className="flex-y gap-small padding-small">
      {status?.repository && (
        <SimpleButton
          extraClass={buttonClass}
          svg={<Icon name="Copy" size={16} />}
          text="Copy Repo URL"
          action={() => {
            const base = status.repository!.startsWith("http")
              ? status.repository!
              : `https://github.com/${status.repository}`;
            const url = status.pathPrefix
              ? `${base}/tree/${status.defaultBranch || "main"}/${status.pathPrefix}`
              : base;
            navigator.clipboard.writeText(url);
            toast.success("Repo URL copied to clipboard");
          }}
          disabled={!!actionLoading}
        />
      )}
      <SimpleButton
        extraClass={buttonClass}
        svg={<Icon name="Upload" size={16} />}
        text="Push Bucket -> GitHub"
        action={handlePush}
        disabled={!!actionLoading}
      />
      <SimpleButton
        extraClass={buttonClass}
        svg={<Icon name="RefreshCw" size={16} />}
        text="Check changes on GitHub"
        action={handleCheckChanges}
        disabled={!!actionLoading}
      />
      <SimpleButton
        extraClass={buttonClass}
        svg={<Icon name="Unlink" size={16} />}
        text="Unlink"
        action={handleUnlink}
        disabled={!!actionLoading}
      />

      <div className="flex-y gap-small padding-small border-t border-yellow-200">
        <SimpleButton
          extraClass={buttonClass}
          svg={<Icon name="ArrowLeftRight" size={16} />}
          text={translateDirection === "en-es" ? "EN → ES" : "ES → EN"}
          action={() =>
            setTranslateDirection((d) => (d === "en-es" ? "es-en" : "en-es"))
          }
          disabled={!enEsOnly || !!actionLoading}
        />
        <SimpleButton
          extraClass={buttonClass}
          svg={<Icon name="Languages" size={16} />}
          text={
            actionLoading === "translate" && translateProgress
              ? `Translating ${translateProgress.completed}/${translateProgress.total}…`
              : "Translate all lessons"
          }
          action={handleTranslateAll}
          disabled={!enEsOnly || !!actionLoading}
        />
        {!enEsOnly && (
          <p className="text-small text-yellow-700">
            Only available for courses with exactly EN and ES.
          </p>
        )}
      </div>

      {changes?.hasChanges && (
        <div className="flex-y gap-small padding-small border-t border-yellow-200">
          {changes.syncableChanges && changes.syncableChanges.totalFiles > 0 && (
            <div className="text-small text-yellow-800">
              <div className="font-medium margin-bottom-small">
                Cambios sincronizables:
              </div>
              {changes.syncableChanges.lessons?.map((l) => (
                <div key={l.slug} className="margin-bottom-small">
                  <span className="font-medium">{l.slug}:</span>{" "}
                  {l.files.map((f) => f.filename).join(", ")}
                </div>
              ))}
              {changes.syncableChanges.assets?.length > 0 && (
                <div className="margin-bottom-small">
                  <span className="font-medium">Assets:</span>{" "}
                  {changes.syncableChanges.assets
                    .map((a) => a.filename)
                    .join(", ")}
                </div>
              )}
            </div>
          )}

          {changes.skippedChanges &&
            changes.skippedChanges.files?.length > 0 && (
              <div className="text-small text-yellow-700">
                <div className="font-medium margin-bottom-small">
                  Archivos no sincronizados ({changes.skippedChanges.totalFiles}):
                </div>
                <ul className="list-style-disc padding-left-medium">
                  {changes.skippedChanges.files.slice(0, 5).map((f, i) => (
                    <li key={i}>
                      {f.filename}
                      {f.reason ? ` (${f.reason})` : ""}
                    </li>
                  ))}
                  {changes.skippedChanges.files.length > 5 && (
                    <li>...y {changes.skippedChanges.files.length - 5} más</li>
                  )}
                </ul>
              </div>
            )}

          {(changes.syncableChanges?.totalFiles ?? 0) > 0 && (
            <SimpleButton
              extraClass={buttonClass}
              svg={<Icon name="Download" size={16} />}
              text="Pull GitHub -> Bucket"
              action={handlePull}
              disabled={!!actionLoading}
            />
          )}
        </div>
      )}
    </div>
  );
}
