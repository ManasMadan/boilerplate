{{- define "mail.name" -}}
{{- .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}

{{- define "mail.labels" -}}
app.kubernetes.io/name: stalwart
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "mail.selectorLabels" -}}
app.kubernetes.io/name: stalwart
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "mail.emailDomain" -}}
{{- .Values.emailDomain | default (required "domain is required" .Values.domain) -}}
{{- end -}}

{{- define "mail.hostname" -}}
{{- .Values.hostname | default (printf "mail.%s" (include "mail.emailDomain" .)) -}}
{{- end -}}

{{/*
The settings, as stalwart-cli apply operations (NDJSON, one per line; lists are objects
keyed "0", "1", …; "#domain" is the domain of an earlier line): logs to stdout, the
domain with our own DKIM key and certificate, the host name, the account the
application submits as, and the delivery-failure webhook. Upserts match on a natural
key, so applying them again changes nothing that didn't change. Secrets are
read from files and the environment by the server itself, except the submission
password, which the plan init container writes in for @SMTP_PASSWORD@.
*/}}
{{- define "mail.plan" -}}
{{- $domain := include "mail.emailDomain" . -}}
{{- $ops := list
  (dict "@type" "reconcile" "object" "Tracer" "matchOn" "*" "value" (dict "console" (dict
    "@type" "Stdout" "level" "info" "enable" true "ansi" false "buffered" false
    "multiline" false "lossy" false "events" dict "eventsPolicy" "exclude")))
  (dict "@type" "upsert" "object" "Domain" "matchOn" (list "name") "value" (dict "domain" (dict
    "name" $domain
    "certificateManagement" (dict "@type" "Manual")
    "dkimManagement" (dict "@type" "Manual")
    "dnsManagement" (dict "@type" "Manual")
    "subAddressing" (dict "@type" "Enabled"))))
  (dict "@type" "upsert" "object" "Certificate" "matchOn" (list "certificate") "value" (dict "certificate" (dict
    "certificate" (dict "@type" "File" "filePath" "/etc/stalwart/tls/tls.crt")
    "privateKey" (dict "@type" "File" "filePath" "/etc/stalwart/tls/tls.key"))))
  (dict "@type" "update" "object" "SystemSettings" "value" (dict
    "defaultHostname" (include "mail.hostname" .)
    "defaultDomainId" "#domain"
    "defaultCertificateId" "#certificate"))
  (dict "@type" "upsert" "object" "DkimSignature" "matchOn" (list "selector") "value" (dict "dkim" (dict
    "@type" "Dkim1RsaSha256"
    "domainId" "#domain"
    "selector" .Values.dkim.selector
    "privateKey" (dict "@type" "File" "filePath" "/etc/stalwart/dkim/private.key"))))
  (dict "@type" "upsert" "object" "Account" "matchOn" (list "name" "domainId") "value" (dict "sender" (dict
    "@type" "User"
    "name" .Values.submission.account
    "domainId" "#domain"
    "credentials" (dict "0" (dict "@type" "Password" "secret" "@SMTP_PASSWORD@")))))
-}}
{{- if .Values.webhook.enabled -}}
{{- $events := dict -}}
{{- range .Values.webhook.events }}{{ $_ := set $events . true }}{{ end -}}
{{- $ops = append $ops (dict "@type" "upsert" "object" "WebHook" "matchOn" (list "url") "value" (dict "webhook" (dict
    "url" (required "webhook.url is required with the webhook on" .Values.webhook.url)
    "signatureKey" (dict "@type" "EnvironmentVariable" "variableName" "STALWART_WEBHOOK_SECRET")
    "httpAuth" (dict "@type" "Unauthenticated")
    "httpHeaders" dict
    "events" $events
    "eventsPolicy" "include"))) -}}
{{- end -}}
{{- range $i, $op := concat $ops .Values.extraPlan -}}
{{- if $i }}{{ "\n" }}{{ end }}{{ toJson $op }}
{{- end -}}
{{- end -}}

{{/* What the server reads and writes, in recovery mode and normally alike. */}}
{{- define "mail.serverMounts" -}}
- { name: config, mountPath: /etc/stalwart/config.json, subPath: config.json, readOnly: true }
- { name: data, mountPath: /var/lib/stalwart }
- { name: tls, mountPath: /etc/stalwart/tls, readOnly: true }
- { name: dkim, mountPath: /etc/stalwart/dkim, readOnly: true }
- { name: provision, mountPath: /run/provision }
- { name: tmp, mountPath: /tmp }
{{- end -}}
