import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as http from 'typed-rest-client/HttpClient'

import { inject, injectable } from 'inversify'
import { IBuildAgent, IExecResult, TYPES } from './models'
import { IVersionManager } from './versionManager'
import { ISetupSettings } from '../tools/common/models'

export interface IDotnetTool {
    disableTelemetry(): void
    toolInstall(toolName: string, versionRange: string, setupSettings: ISetupSettings): Promise<string>
}

@injectable()
export class DotnetTool implements IDotnetTool {
    protected buildAgent: IBuildAgent
    protected versionManager: IVersionManager
    private httpClient: http.HttpClient

    private static readonly nugetRoot: string = 'https://azuresearch-usnc.nuget.org/query'

    constructor(@inject(TYPES.IBuildAgent) buildAgent: IBuildAgent, @inject(TYPES.IVersionManager) versionManager: IVersionManager) {
        this.buildAgent = buildAgent
        this.versionManager = versionManager
        this.httpClient = new http.HttpClient('dotnet', undefined, this.buildAgent.proxyConfiguration(DotnetTool.nugetRoot))
    }

    public disableTelemetry(): void {
        this.buildAgent.setVariable('DOTNET_CLI_TELEMETRY_OPTOUT', 'true')
        this.buildAgent.setVariable('DOTNET_NOLOGO', 'true')
    }

    public execute(cmd: string, args: string[]): Promise<IExecResult> {
        console.log(`Command: ${cmd} ${args.join(' ')}`)
        return this.buildAgent.exec(cmd, args)
    }

    public async toolInstall(toolName: string, versionRange: string, setupSettings: ISetupSettings): Promise<string> {
        let version: string | null = this.versionManager.cleanVersion(setupSettings.versionSpec) || setupSettings.versionSpec
        console.log('')
        console.log('--------------------------')
        console.log(`Acquiring ${toolName} version spec: ${version}`)
        console.log('--------------------------')

        if (!this.versionManager.isExplicitVersion(version)) {
            version = await this.queryLatestMatch(toolName, version, setupSettings.includePrerelease)
            if (!version) {
                throw new Error(`Unable to find ${toolName} version '${version}'.`)
            }
        }

        if (!this.versionManager.satisfies(version, versionRange, { includePrerelease: setupSettings.includePrerelease })) {
            throw new Error(
                `Version spec '${setupSettings.versionSpec}' resolved as '${version}' does not satisfy the range '${versionRange}'.` +
                    'Check https://raw.githubusercontent.com/GitTools/actions/main/docs/versions.md for more information'
            )
        }

        let toolPath: string | null = null
        if (!setupSettings.preferLatestVersion) {
            toolPath = this.buildAgent.find(toolName, setupSettings.versionSpec)
            if (toolPath) {
                console.log('--------------------------')
                console.log(`${toolName} version: ${version} found in local cache at ${toolPath}.`)
                console.log('--------------------------')
            }
        }

        if (!toolPath) {
            toolPath = await this.acquireTool(toolName, version, setupSettings.ignoreFailedSources)
            console.log('--------------------------')
            console.log(`${toolName} version: ${version} installed.`)
            console.log('--------------------------')
        }

        this.buildAgent.debug(`toolPath: ${toolPath}`)

        await this.setDotnetRoot()
        this.buildAgent.addPath(toolPath)

        return toolPath
    }

    protected async setDotnetRoot(): Promise<void> {
        if (os.platform() !== 'win32' && !this.buildAgent.getVariable('DOTNET_ROOT')) {
            let dotnetPath = await this.buildAgent.which('dotnet')
            dotnetPath = fs.readlinkSync(dotnetPath) || dotnetPath
            const dotnetRoot = path.dirname(dotnetPath)
            this.buildAgent.setVariable('DOTNET_ROOT', dotnetRoot)
        }
    }

    private async queryLatestMatch(toolName: string, versionSpec: string, includePrerelease: boolean): Promise<string> {
        this.buildAgent.debug(
            `querying tool versions for ${toolName}${versionSpec ? `@${versionSpec}` : ''} ${includePrerelease ? 'including pre-releases' : ''}`
        )

        const toolNameParam = encodeURIComponent(toolName.toLowerCase())
        const prereleaseParam = includePrerelease ? 'true' : 'false'
        const downloadPath = `${DotnetTool.nugetRoot}?q=${toolNameParam}&prerelease=${prereleaseParam}&semVerLevel=2.0.0&take=1`

        const res = await this.httpClient.get(downloadPath)

        if (!res || res.message.statusCode !== 200) {
            return null
        }

        const body: string = await res.readBody()
        const data = JSON.parse(body).data

        const versions = (data[0].versions as { version: string }[]).map(x => x.version)
        if (!versions || !versions.length) {
            return null
        }

        this.buildAgent.debug(`got versions: ${versions.join(', ')}`)

        return this.versionManager.evaluateVersions(versions, versionSpec, {
            includePrerelease
        })
    }

    private async acquireTool(toolName: string, version: string, ignoreFailedSources: boolean): Promise<string> {
        const tempDirectory = await this.buildAgent.createTempDir()
        let args = ['tool', 'install', toolName, '--tool-path', tempDirectory]

        if (ignoreFailedSources) {
            args.push('--ignore-failed-sources')
        }

        if (version) {
            version = this.versionManager.cleanVersion(version)
            args = args.concat(['--version', version])
        }

        const result = await this.execute('dotnet', args)
        const status = result.code === 0 ? 'success' : 'failure'
        const message = result.code === 0 ? result.stdout : result.stderr

        this.buildAgent.debug(`tool install result: ${status} ${message}`)

        if (result.code) {
            throw new Error('Error installing tool')
        }

        return await this.buildAgent.cacheDir(tempDirectory, toolName, version)
    }
}
