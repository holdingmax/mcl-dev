# MCL WMS — Sistema de Agentes Autonomos
## Arquitectura Completa

```
┌─────────────────────────────────────────────────────────────┐
│                    GITHUB ACTIONS RUNTIME                     │
│                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │  ANDS (2 AM) │  │ ADMP (7 AM)  │  │ AAID (4 AM)  │  │ AREF (manual)│ │
│  │  Deploy Agent │  │ Monitor Agent│  │ Audit Agent  │  │ Refactor Agt │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘ │
│         │                  │                  │                 │         │
│         └─────────┬────────┴─────────┬────────┴─────────────────┘         │
│                   │                  │                         │
│            ┌──────┴──────┐   ┌──────┴──────┐                 │
│            │  Shared Lib  │   │  Claude API  │                 │
│            │  (firebase,  │   │  (analysis,  │                 │
│            │   reporter)  │   │   decisions) │                 │
│            └──────┬──────┘   └─────────────┘                 │
│                   │                                           │
└───────────────────┼───────────────────────────────────────────┘
                    │
        ┌───────────┼───────────────┐
        │           │               │
   ┌────┴────┐ ┌───┴────┐  ┌──────┴──────┐
   │Firebase │ │Firebase│  │   Slack /    │
   │Firestore│ │Hosting │  │   Artifacts  │
   └─────────┘ └────────┘  └─────────────┘
```

## Agentes

### ANDS — Agente Nocturno de Despliegue Seguro
- **Cron:** 2:00 AM UTC (10 PM EST)
- **Funcion:** Ejecuta despliegues canary/blue-green segun plan
- **Flujo:** Check flags → Build → Deploy preview → Collect metrics → Claude analysis → Promote/Rollback → Report

### ADMP — Agente Diario de Monitoreo de Performance
- **Cron:** 11:00 AM UTC (7 AM EST)
- **Funcion:** Recopila metricas de Firestore y performance
- **Flujo:** Collect metrics → Compare baselines → Claude analysis → Generate alerts → Report

### AAID — Agente Auditor de Integridad de Datos
- **Cron:** 8:00 AM UTC (4 AM EST)
- **Funcion:** Valida integridad de datos criticos
- **Flujo:** Check billing integrity → Detect orphans → Validate consistency → Claude analysis → Report

### AREF — Agente de Refactoring Arquitectonico
- **Trigger:** Manual (workflow_dispatch) — nunca automatico
- **Funcion:** Ejecuta refactoring mecanico de bajo/medio riesgo
- **Flujo:** Load task → Execute changes → Create branch → Create PR → Report
- **Regla de oro:** NUNCA despliega directo. Siempre crea PR para revision humana.
- **Tareas asignables:** F1 (AAID checks), F2 (partir index.js), F6 (tipos + tests)

## Comunicacion entre agentes

Los agentes NO se comunican entre si directamente.
Comparten estado via:
1. **Firestore:** Coleccion `_agent_state` con documentos por agente
2. **GitHub Artifacts:** Reportes diarios almacenados 30 dias
3. **Feature Flags:** Coleccion `config/feature_flags` en Firestore

## Secretos requeridos (GitHub Secrets)

| Secret | Uso |
|--------|-----|
| FIREBASE_SERVICE_ACCOUNT | JSON key de service account Firebase |
| FIREBASE_PROJECT_ID | ID del proyecto Firebase |
| FIREBASE_TOKEN | Token para Firebase CLI deploy |
| ANTHROPIC_API_KEY | API key para Claude |
| SLACK_WEBHOOK_URL | (Opcional) Webhook para notificaciones |

## Politica de decisiones

Los agentes NUNCA piden permiso. Toman decisiones basadas en:
- Metricas cuantitativas (thresholds predefinidos)
- Analisis de Claude (consulta, no aprobacion)
- Estado de feature flags
- Historial de deploys anteriores

Prioridad absoluta: **ESTABILIDAD > VELOCIDAD > FEATURES**
