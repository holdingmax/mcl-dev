export default function InAppBrowserBlock() {
  const ua = navigator.userAgent || ''
  const isAndroid = /Android/i.test(ua)
  const currentUrl = window.location.href

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(currentUrl)
      alert('Link copiado. Pégalo en Safari o Chrome.')
    } catch {
      window.prompt('Copia este link y ábrelo en Safari o Chrome:', currentUrl)
    }
  }

  const openInChromeAndroid = () => {
    const noScheme = currentUrl.replace(/^https?:\/\//, '')
    window.location.href = `intent://${noScheme}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(currentUrl)};end`
  }

  return (
    <div className="fixed inset-0 z-50 bg-white flex flex-col items-center justify-center p-6 text-center">
      <div className="max-w-sm w-full">
        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-amber-100 flex items-center justify-center">
          <svg className="w-8 h-8 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <h1 className="text-xl font-bold text-gray-800 mb-2">Abre este link en tu navegador</h1>
        <p className="text-sm text-gray-600 mb-6">
          El navegador interno de esta app no soporta el inicio de sesión con Google.
          Abre el link en <span className="font-semibold">Safari</span> o <span className="font-semibold">Chrome</span> para continuar.
        </p>

        {isAndroid ? (
          <button
            onClick={openInChromeAndroid}
            className="w-full bg-mcl-blue text-white font-semibold py-3 rounded-lg mb-3 hover:bg-mcl-blue/90 transition-colors"
          >
            Abrir en Chrome
          </button>
        ) : (
          <div className="text-sm text-gray-500 mb-4 bg-gray-50 rounded-lg p-3 border border-gray-100">
            Toca <span className="font-semibold">⋯</span> arriba a la derecha y selecciona <span className="font-semibold">"Abrir en Safari"</span>.
          </div>
        )}

        <button
          onClick={copyLink}
          className="w-full bg-gray-100 text-gray-700 font-semibold py-3 rounded-lg hover:bg-gray-200 transition-colors"
        >
          Copiar link
        </button>
      </div>
    </div>
  )
}
