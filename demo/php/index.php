<?php
// Local demonstration responses; no external systems or customer data.
$number = filter_input(INPUT_GET, 'n', FILTER_VALIDATE_INT) ?: 1;
usleep((35 + abs($number % 91) + ($number % 19 === 0 ? 130 : 0)) * 1000);
$route = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$statuses = ['/missing' => 404, '/unavailable' => 500, '/redirect' => 302];
$status = $statuses[$route] ?? 200;
http_response_code($status);
header('Content-Type: application/json');
if ($status === 302) {
    header('Location: /catalog');
}
$body = json_encode([
    'demo' => true,
    'application' => 'demo-store',
    'pid' => getmypid(),
    'path' => $route,
    'time' => microtime(true),
    'status' => $status,
    'products' => $status === 200 ? [['sku' => 'book-1', 'name' => 'Sketchbook']] : [],
]);
header('Content-Length: ' . strlen($body));
echo $body;
