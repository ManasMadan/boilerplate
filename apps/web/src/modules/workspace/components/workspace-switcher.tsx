"use client";

import { Button } from "@repo/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/components/dropdown-menu";
import { ChevronsUpDown, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { useAuthErrorMessage } from "@/modules/auth";
import {
  isPersonal,
  useActiveWorkspace,
  useSwitchWorkspace,
  useWorkspaces,
} from "../hooks/use-workspace";
import { CreateWorkspaceDialog } from "./create-workspace-dialog";

/** Header menu: which workspace you're in, switching between them, creating one. */
export function WorkspaceSwitcher() {
  const t = useTranslations("workspace.switcher");
  const errorMessage = useAuthErrorMessage();
  const workspaces = useWorkspaces();
  const active = useActiveWorkspace();
  const switchTo = useSwitchWorkspace();
  const [creating, setCreating] = useState(false);
  const activeId = active.data?.id;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="sm" className="max-w-48 gap-1" aria-label={t("label")} />
          }
        >
          <span className="truncate">
            {active.data ? (isPersonal(active.data) ? t("personal") : active.data.name) : "…"}
          </span>
          <ChevronsUpDown className="size-3.5 opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t("label")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={activeId ?? ""}
              onValueChange={(id) => {
                if (id && id !== activeId)
                  switchTo(id).catch((error: unknown) => toast.error(errorMessage(error)));
              }}
            >
              {(workspaces.data ?? []).map((workspace) => (
                <DropdownMenuRadioItem key={workspace.id} value={workspace.id}>
                  {isPersonal(workspace) ? t("personal") : workspace.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setCreating(true)}>
            <Plus /> {t("create")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
