declare module 'html2pdf.js' {
  interface Html2PdfOptions {
    margin?: number | number[]
    filename?: string
    html2canvas?: Record<string, unknown>
    jsPDF?: Record<string, unknown>
  }
  interface Html2PdfInstance {
    from(element: HTMLElement | string): Html2PdfInstance
    set(options: Html2PdfOptions): Html2PdfInstance
    outputPdf(type: 'blob'): Promise<Blob>
    outputPdf(type: 'datauristring'): Promise<string>
    save(): Promise<void>
  }
  function html2pdf(): Html2PdfInstance
  export default html2pdf
}
