## Note
The application 
Mandatory files:
* names.txt
    List all files to extract from HAR.
* session.har
    HAR export.

## names.txt
A row for each file to extract.
Below the file example:
```
iwprescript.js
iwprescript_sap_main.js
iwsconfig.js
iwsconfig_main.js
iwscript.js
iwsutils.js
```

Install as global command:
```
npm link
har-extract session.har --name-list names.txt --clean
```

`--clean` removes the output folder, `manifest.json`, and `extract.log` before extraction starts.

## Defaults
If no paths are provided, the tool uses:
- `input/session.har`
- `input/names.txt`
- output folder `output/`
- `output/manifest.json`
- `output/extract.log`

Example with defaults:
```
node ./dist/har-extract
```

## Deploy
clone the repository.

### Install
```
node i
```

### Build
```
npm run build
```

### Prepare
Update "names.txt" file, adding the wished files to export.
Add the HAR export (named "session.har") in the "input" folder.

### Test
```
node ./dist/har-extract
```


