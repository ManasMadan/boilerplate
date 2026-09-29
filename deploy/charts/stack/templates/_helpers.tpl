{{/*
Names, labels and the per-service configuration every template works from.
*/}}

{{- define "stack.name" -}}
{{- .Release.Name | trunc 40 | trimSuffix "-" -}}
{{- end -}}

{{/* A service's resource name: <release>-<service>. */}}
{{- define "stack.fullname" -}}
{{- $root := index . 0 -}}
{{- printf "%s-%s" (include "stack.name" $root) (index . 1) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* A service's in-cluster host name. */}}
{{- define "stack.host" -}}
{{- $root := index . 0 -}}
{{- printf "%s.%s.svc.cluster.local" (include "stack.fullname" .) $root.Release.Namespace -}}
{{- end -}}

{{/* A service's in-cluster URL (http, on its port). */}}
{{- define "stack.url" -}}
{{- $root := index . 0 -}}
{{- $svc := include "stack.service" (list $root (index . 1)) | fromYaml -}}
{{- printf "http://%s:%v" (include "stack.host" .) $svc.port -}}
{{- end -}}

{{/* The public site's origin. */}}
{{- define "stack.siteUrl" -}}
{{- printf "%s://%s" .Values.site.scheme (required "site.host is required" .Values.site.host) -}}
{{- end -}}

{{- define "stack.labels" -}}
{{- $root := index . 0 -}}
app.kubernetes.io/name: {{ index . 1 }}
app.kubernetes.io/instance: {{ $root.Release.Name }}
app.kubernetes.io/part-of: {{ include "stack.name" $root }}
app.kubernetes.io/version: {{ $root.Values.image.tag | quote }}
app.kubernetes.io/managed-by: {{ $root.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" $root.Chart.Name $root.Chart.Version }}
{{- end -}}

{{- define "stack.selectorLabels" -}}
{{- $root := index . 0 -}}
app.kubernetes.io/name: {{ index . 1 }}
app.kubernetes.io/instance: {{ $root.Release.Name }}
{{- end -}}

{{/*
A service's settings: `defaults` with the service's own values merged over them
(maps merge key by key; lists and scalars replace).
*/}}
{{- define "stack.service" -}}
{{- $root := index . 0 -}}
{{- $name := index . 1 -}}
{{- $own := index $root.Values.services $name | default dict -}}
{{- mergeOverwrite (deepCopy $root.Values.defaults) (deepCopy $own) | toYaml -}}
{{- end -}}

{{/* The image a service runs. */}}
{{- define "stack.image" -}}
{{- $root := index . 0 -}}
{{- $svc := index . 1 -}}
{{- if $svc.imageRef -}}
{{- $svc.imageRef -}}
{{- else -}}
{{- printf "%s/%s:%s" $root.Values.image.registry $svc.image (required "image.tag is required" $root.Values.image.tag) -}}
{{- end -}}
{{- end -}}

{{/* The Secret holding a service's other secrets (none for `secretFrom: none`). */}}
{{- define "stack.secretName" -}}
{{- $root := index . 0 -}}
{{- $name := index . 1 -}}
{{- $svc := index . 2 -}}
{{- $from := $svc.secretFrom | default $name -}}
{{- if ne $from "none" -}}
{{- include "stack.fullname" (list $root $from) -}}
{{- end -}}
{{- end -}}

{{/* The connection-URL Secret for a database role (app_api → db-app-api). */}}
{{- define "stack.dbSecret" -}}
{{- $root := index . 0 -}}
{{- printf "%s%s" $root.Values.database.secretPrefix (index . 1 | replace "_" "-") -}}
{{- end -}}
