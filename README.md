# Backend privado de Gemini para ChambaU

Este paquete deja preparada una ruta de servidor para que la tienda Shopify pueda llamar a Gemini mediante un app proxy. La clave nunca se envía al navegador ni se guarda en el tema.

## Configuración

1. Copia `.env.example` como `.env` en el proveedor privado que vaya a ejecutar este servidor.
2. Define `GEMINI_API_KEY` con la clave nueva desde el panel de secretos del proveedor. No la pegues en Shopify, Liquid, JavaScript público o este repositorio.
3. Define `GEMINI_MODEL` con un modelo habilitado en tu cuenta.
4. Define `SHOPIFY_APP_SECRET` y `SHOPIFY_SHOP_DOMAIN`.
5. Mantén `ALLOW_DEV_ENDPOINT=false` en producción.
6. Ejecuta `npm install` y luego `npm start`.

## Rutas

- `GET /health` comprueba que el proceso responde, sin revelar configuración.
- `POST /api/gemini` recibe `{ "prompt": "..." }`, valida la firma del app proxy y devuelve `{ "answer": "..." }`.

La ruta incluye límite de tamaño, caducidad de firma, comparación constante, timeout y mensajes de error sin secretos. Todavía no concede acceso por plan, no registra créditos y no procesa suscripciones: esas reglas deben conectarse después de elegir la aplicación de membresía y el proveedor de backend. No debe exponerse públicamente hasta completar esa capa.

La llamada usa el endpoint oficial `models.generateContent` y el encabezado `x-goog-api-key`; revisa los modelos y límites actuales antes de desplegar.
