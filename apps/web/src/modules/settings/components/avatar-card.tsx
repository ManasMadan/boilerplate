"use client";

import {
  checkUpload,
  UploadFailedError,
  useFileQuery,
  useUploadFileMutation,
} from "@repo/client/api/files/upload";
import { useSystemInfoQuery } from "@repo/client/api/system/info";
import { useSetAvatarMutation } from "@repo/client/api/user/avatar";
import { useMeQuery } from "@repo/client/api/user/me";
import { uploadPurposes } from "@repo/contracts/files";
import { Avatar, AvatarFallback, AvatarImage } from "@repo/ui/components/avatar";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Spinner } from "@repo/ui/components/spinner";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { useApiErrorMessage } from "@/lib/use-api-error";

/**
 * The profile picture. A chosen image is uploaded, checked by the worker (virus scan,
 * re-encoded without metadata), and only then becomes the picture. Hidden when the
 * deployment has uploads off.
 */
export function AvatarCard() {
  const t = useTranslations("settings.profile.avatar");
  const tAll = useTranslations();
  const errorMessage = useApiErrorMessage();
  const input = useRef<HTMLInputElement>(null);
  const { data: system } = useSystemInfoQuery();
  const { data: me } = useMeQuery();
  const session = authClient.useSession();
  const upload = useUploadFileMutation();
  const setAvatar = useSetAvatarMutation();
  const [fileId, setFileId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const file = useFileQuery(fileId);

  useEffect(() => {
    if (!fileId || !file.data) return;
    if (file.data.status === "rejected") {
      setProblem(tAll(`errors.${file.data.rejectReason ?? "FILE_UNREADABLE"}`));
      setFileId(null);
    } else if (file.data.status === "ready") {
      setFileId(null);
      setAvatar.mutate(
        { fileId },
        {
          onSuccess: () => {
            toast.success(t("updated"));
            void session.refetch();
          },
          onError: (error) => setProblem(errorMessage(error)),
        },
      );
    }
  }, [fileId, file.data, setAvatar, session, t, tAll, errorMessage]);

  if (!system?.features.files || !me) return null;

  async function choose(chosen: File | undefined) {
    if (input.current) input.current.value = "";
    if (!chosen) return;
    setProblem(null);
    const refused = checkUpload("avatar", chosen);
    if (refused) {
      setProblem(tAll(`errors.${refused.code}`, refused.params));
      return;
    }
    try {
      const completed = await upload.mutateAsync({ purpose: "avatar", file: chosen });
      setFileId(completed.id);
    } catch (error) {
      setProblem(
        error instanceof UploadFailedError ? tAll("errors.FILE_NOT_UPLOADED") : errorMessage(error),
      );
    }
  }

  const busy = upload.isPending || fileId !== null || setAvatar.isPending;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-4">
        <Avatar className="size-16">
          {me.image ? <AvatarImage src={me.image} alt="" /> : null}
          <AvatarFallback className="text-lg">{me.name.slice(0, 1).toUpperCase()}</AvatarFallback>
        </Avatar>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <input
              ref={input}
              type="file"
              // The button below is the control; this only opens the file picker.
              hidden
              accept={uploadPurposes.avatar.types.join(",")}
              disabled={busy}
              onChange={(event) => void choose(event.target.files?.[0])}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => input.current?.click()}
            >
              {me.image ? t("change") : t("upload")}
            </Button>
            {me.image ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() =>
                  setAvatar.mutate(
                    { fileId: null },
                    {
                      onSuccess: () => {
                        toast.success(t("removed"));
                        void session.refetch();
                      },
                      onError: (error) => setProblem(errorMessage(error)),
                    },
                  )
                }
              >
                {t("remove")}
              </Button>
            ) : null}
          </div>
          {busy ? (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              {/* Decorative: the text beside it is what's announced. */}
              <Spinner role="presentation" aria-hidden="true" aria-label={undefined} />
              {upload.isPending ? t("uploading") : t("checking")}
            </p>
          ) : null}
          {problem ? (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
