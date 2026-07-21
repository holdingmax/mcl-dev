import { Client } from '../types'

export const CLIENT_SEED_DATA: Omit<Client, 'id'>[] = [
  {
    name: 'LI-Sodimac',
    email_recipients: [
      { name: 'Daniela Vidal',      email: 'dsvidale@sodimac.cl' },
      { name: 'Diana Iglesias',     email: 'ext_diglesiase@sodimac.cl' },
      { name: 'Omar Bustos',        email: 'obustosa@sodimac.cl' },
      { name: 'Gonzalo Córdova',    email: 'gandcordovam@sodimac.cl' },
      { name: 'Elizabeth Gallardo', email: 'ext_elizagallardof@sodimac.cl' },
    ],
    shippers: [
      { name: 'ORGILL CENTURY SPRING',                      address: '4100 S. HOUSTON LEVVE SR.', city: 'MEMPHIS',          province: 'TEN', country: 'US',      zip: '38017'   },
      { name: 'ORGILL CHEF CRAFT',                          address: '4100 S. HOUSTON LEWE SR.',  city: 'MEMPHIS',          province: 'TEN', country: 'US',      zip: '38017'   },
      { name: 'ORGILL INC',                                 address: '4100S. HOUSTON LEWE SR.',   city: 'MEMPHIS',          province: 'TEN', country: 'US',      zip: '38017'   },
      { name: 'ORGILL INC MALCO TOOLS',                     address: '4100S. HOUSTON LEWE SR.',   city: 'MEMPHIS',          province: 'TEN', country: 'US',      zip: '38017'   },
      { name: 'ORGILL INC MASTER MAGNETICS',                address: '4100S. HOUSTON LEWE SR.',   city: 'MEMPHIS',          province: 'TEN', country: 'US',      zip: '38017'   },
      { name: 'CHARBROIL LLC',                              address: 'Belfast Avenue 1442',       city: 'COLUMBUS',         province: 'GEO', country: 'US',      zip: '31904'   },
      { name: 'ACE - SWIFT RESPONSE - FLEX SEAL',           address: 'CANONS COURT 22 VICTORIA STREET HAMILTON HM 12 BERMUDA', city: 'NEW YORK', province: 'NY', country: 'US', zip: '507' },
      { name: 'HAMPTON PRODUCTS INTERNATIONAL CORPORATION', address: '50 ICON FOOTHILL RANCH CALIFORNIA', city: 'FOOTHILL RANCH', province: 'CA', country: 'US', zip: '92610' },
      { name: 'HAMPTON PRODUCTS / ORGILL',                  address: '4100 S. HOUSTON LEVVE SR.', city: 'MEMPHIS',          province: 'TEN', country: 'US',      zip: '38017'   },
      { name: 'ITWGB GLOBAL BRANDS / ORGILL',               address: '4100 S. HOUSTON LEVVE SR.', city: 'MEMPHIS',          province: 'TEN', country: 'US',      zip: '38017'   },
      { name: 'MALCO PRODUCTS / ORGILL',                    address: '4100 S. HOUSTON LEVVE SR.', city: 'MEMPHIS',          province: 'TEN', country: 'US',      zip: '38017'   },
      { name: 'ARROW FASTENER CO., LLC',                    address: 'MAYHILL STREET 271',        city: 'SADDLE BROOK',     province: 'NJ',  country: 'US',      zip: '7663'    },
      { name: 'BLACK & DECKER (U.S.) INC',                  address: '9850 Premier Parkway',      city: 'MIRAMAR BEACH',    province: 'FL',  country: 'US',      zip: '33025'   },
      { name: 'COAST CUTLERY CO',                           address: '8033 NE HOLMAN STREET',     city: 'PORTLAND',         province: 'OR',  country: 'US',      zip: '97218'   },
      { name: 'LORAMA GROUP INTERNATIONAL INC.',            address: 'Ground Floor, White Park House White Park Road, St. Michael', city: 'SAINT MICHAEL', province: 'SM', country: 'Barbados', zip: '11135' },
      { name: 'ARROW HOME / ORGILL',                        address: '4100 S. HOUSTON LEVVE SR.', city: 'MEMPHIS',          province: 'TEN', country: 'US',      zip: '38017'   },
      { name: 'INDUSTRIAL EXPORT US',                       address: '9930 NW 21 ST ST, Suite 207', city: 'MIAMI',          province: 'FL',  country: 'US',      zip: '33172'   },
      { name: 'KLEIN TOOLS INC.',                           address: '501 Easy Drive Mansfield, TX 76063 USA', city: 'MANSFIELD', province: 'TX', country: 'US', zip: '76063'  },
      { name: 'MASTER LOCK COMPANY LLC',                    address: '6744 S HOWELL',             city: 'MILWAUKEE',        province: 'WIS', country: 'US',      zip: '53154'   },
      { name: 'SIMPSON STRONGTIE CHILE LIMITADA',           address: 'Av Vitacura 2909',          city: 'SANTIAGO DE CHILE', province: 'RM', country: 'CL',      zip: '7591537' },
      { name: 'THERMWELL PRODUCTS CO INC',                  address: '420 Route 17 South',        city: 'MAHWAH',           province: 'NJ',  country: 'US',      zip: '7430'    },
    ],
    consignees: [
      {
        name: 'SODIMAC COLOMBIA S.A.',
        full_address: 'NIT: 800.242.106-2\nCRA. 68D NO. 80-70\nTEL: 457 81 00\nBOGOTA - COLOMBIA',
        notify_to: '',
      },
      {
        name: 'TIENDAS DEL MEJORAMIENTO DEL H - Peru',
        full_address: 'Avenida Angamos Este N° 1805, Interior 2, oficina 2, distrito de Surquillo – Lima - Perú\nRUC: 20112273922\nPhone: 511-2119500\nFax: 511-6110418',
        notify_to: '',
      },
      {
        name: 'SODIMAC S.A. - Chile',
        full_address: 'RUT: 96792430-K\nAV. PDTE. EDO. FREI M. 3092\nRENCА - SANTIAGO - CHILE\nPHONE: +56 2 2738 1000',
        notify_to: '_ComexSodimac@Falabella.cl',
      },
      {
        name: 'CONSTRUDECOR S/A - Brasil',
        full_address: 'AVENIDA SANTOS DUMONT, 4475\nARMAZÉM 3\nJARDIM CONCEICÃOZINHA (VICENTE DE CARVALHO)\nGUARUJÁ – SP – BRASIL\nCEP: 11460-006\nCNPJ.: 03.439.316/0038-64\nPhone: +5511 2065-2525\nFax: +5511 2065-2500',
        notify_to: '',
      },
      {
        name: 'HOMECENTER SODIMAC S.A. - Uruguay',
        full_address: 'RUT: 216996650015\nARIZONA 865\nBARRA DE CARRASCO\nCIUDAD DE LA COSTA, (CP 15000) CANELONES – URUGUAY\nPhone: +598 2484 5089',
        notify_to: '',
      },
      {
        name: 'Comercializadora SDMHC, SA DE CV - Mexico',
        full_address: 'RFC CSD161207R2A\nAv. Adolfo Lopez Mateos No. 201 Col Santa Cruz Acatlán CP. 53150 Naucalpan de Juárez, Estado de México\nPhone: +52 (55) 5375 9000 ext. 9341, 9381, 9382',
        notify_to: 'comex.mex@sodimac.com.mx',
      },
    ],
    created_at: new Date().toISOString(),
  },
  {
    name: 'World Logistics Cargo',
    email_recipients: [
      { name: 'Gina Vargas',      email: 'gina.vargas@atlanticairways.aero' },
      { name: 'Billing WLC',      email: 'billing@worldlogcargo.com' },
      { name: 'Heriberto Prieto', email: 'heriberto.prieto@worldlogcargo.com' },
    ],
    shippers: [],
    consignees: [],
    created_at: new Date().toISOString(),
  },
]
