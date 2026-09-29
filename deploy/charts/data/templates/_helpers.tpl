{{- define "data.name" -}}
{{- .Release.Name | trunc 40 | trimSuffix "-" -}}
{{- end -}}

{{- define "data.labels" -}}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: {{ include "data.name" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* The CloudNativePG cluster's name. */}}
{{- define "data.postgres" -}}
{{- printf "%s-postgres" (include "data.name" .) -}}
{{- end -}}

{{/* The primary's read-write service (CloudNativePG creates <cluster>-rw). */}}
{{- define "data.postgresHost" -}}
{{- printf "%s-rw.%s.svc.cluster.local" (include "data.postgres" .) .Release.Namespace -}}
{{- end -}}

{{- define "data.valkey" -}}
{{- printf "%s-valkey" (include "data.name" .) -}}
{{- end -}}

{{- define "data.valkeyHost" -}}
{{- printf "%s.%s.svc.cluster.local" (include "data.valkey" .) .Release.Namespace -}}
{{- end -}}

{{/* A role's Secret: app_api → db-app-api. */}}
{{- define "data.roleSecret" -}}
{{- $root := index . 0 -}}
{{- printf "%s%s" $root.Values.database.secretPrefix (index . 1 | replace "_" "-") -}}
{{- end -}}

{{/* The application roles (every role but the migrator, which owns the database). */}}
{{- define "data.appRoles" -}}
{{- without .Values.database.roles "migrator" | toJson -}}
{{- end -}}
