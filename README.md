# MCL WMS — MinCurl Warehouse Management System

Web-based WMS para MinCurl Logistics (Miami, FL).
Stack: React 18 + Vite + TypeScript + Tailwind CSS + **Firebase** (Auth, Firestore, Storage).

---

## Módulos

1. **Recepción Documental (Counter)** — Registro documental del envío: agente, empresa, PO, destino, driver y foto del Driver License.
2. **Recepción Física** — Registro físico de bultos: tipo de empaque, dimensiones, CBM auto-calculado, peso, ubicación. Genera e imprime el WR.

---

## Setup

### 1. Crear proyecto en Firebase

1. Ir a [console.firebase.google.com](https://console.firebase.google.com) e iniciar sesión con tu cuenta Google.
2. Crear nuevo proyecto (ej: `mcl-wms`).

### 2. Habilitar servicios

**Authentication:**
- Firebase Console → Authentication → Get started
- Sign-in method → Google → Habilitar
- Agregar tu dominio en "Authorized domains" (en dev `localhost` ya está incluido)

**Firestore:**
- Firebase Console → Firestore Database → Create database
- Elegir modo **Production** (las reglas del archivo `firebase/firestore.rules` controlan el acceso)
- Seleccionar región (ej: `us-east1`)

**Storage:**
- Firebase Console → Storage → Get started
- Modo Production también
- Copiar las reglas de `firebase/storage.rules` en la pestaña Rules de Storage

### 3. Obtener configuración web

Firebase Console → Project Settings → General → Tu app web → SDK setup:
- Si no hay app web, hacer clic en `</>` para crear una
- Copiar los valores de `firebaseConfig`

### 4. Variables de entorno

```bash
cp .env.example .env
```

Completar `.env` con los valores de tu proyecto:

```
VITE_FIREBASE_API_KEY=AIzaSy...
VITE_FIREBASE_AUTH_DOMAIN=tu-proyecto.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=tu-proyecto
VITE_FIREBASE_STORAGE_BUCKET=tu-proyecto.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=123456789
VITE_FIREBASE_APP_ID=1:123456789:web:abc123
```

### 5. Cargar datos iniciales (consignatarios)

```bash
# Descargar service account key:
# Firebase Console → Project Settings → Service Accounts → Generate new private key
# Guardar como firebase/serviceAccountKey.json  (NO subir a git)

node firebase/seed.js
```

Esto crea los 5 consignatarios y el contador de WRs en Firestore.

### 6. Instalar y correr

```bash
npm install
npm run dev
```

App disponible en `http://localhost:5173`.

---

## Estructura de datos (Firestore)

| Colección | Descripción |
|---|---|
| `consignees` | Documentos de consignatarios |
| `warehouse_receipts` | Documentos de WRs |
| `warehouse_receipts/{id}/lines` | Subcolección de líneas por WR |
| `config/wr_sequence` | Contador atómico `{ last_num: N }` |

### Numeración de WRs

Formato: `LI` + 10 dígitos → `LI0000000001`, `LI0000000002`, ...
Generado via transacción Firestore sobre `config/wr_sequence`.

---

## Flujo

```
Counter crea WR (Borrador)
    ↓
Counter completa documentación → "Físico pendiente"
    ↓
Recepción Física registra bultos → "Completo"
    ↓
Imprimir / Exportar PDF del WR
```

---

## Build para producción

```bash
npm run build
```

Output en `dist/`. Se puede desplegar en **Firebase Hosting**, Vercel o Netlify.

**Firebase Hosting (opcional):**
```bash
npm install -g firebase-tools
firebase login
firebase init hosting   # seleccionar dist/ como public dir, SPA: yes
firebase deploy
```
