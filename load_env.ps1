# load_env.ps1
Get-Content .env | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)') {
        $name = $matches[1]
        $value = $matches[2] -replace '^["'']|["'']$', ''
        [System.Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
}