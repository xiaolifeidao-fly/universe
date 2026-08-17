declare module '*.less';


declare interface HTTP_RESPONSE {
    success: 1 | 0,
    data: any,
    message: string
}

// Electron API 类型声明
type BusinessType = 'adapundi' | 'singa';

interface UserInfo {
    id: string;
    username: string;
    password: string;
    remark: string;
    businessType?: BusinessType;
}

interface UserApi {
    getUserInfo(username: string): Promise<UserInfo>;
    getUserInfoList(): Promise<UserInfo[]>;
    addUser(userInfo: UserInfo): Promise<void>;
    updateUser(userInfo: UserInfo): Promise<void>;
    deleteUser(username: string): Promise<void>;
    runUser(username: string, enableDeduplication?: boolean, enableResume?: boolean): Promise<void>;
}

interface SyncTimeConfig {
    type: 'daily' | 'monthly';
    hour: number;
    minute: number;
    day?: number;
    businessType?: BusinessType;
}

interface SystemApi {
    getSyncTimeConfig(): Promise<SyncTimeConfig>;
    saveSyncTimeConfig(config: SyncTimeConfig): Promise<void>;
    getSyncTimeConfigByBusiness(businessType: BusinessType): Promise<SyncTimeConfig>;
    saveSyncTimeConfigByBusiness(businessType: BusinessType, config: SyncTimeConfig): Promise<void>;
}

declare global {
    interface Window {
        user?: UserApi;
        system?: SystemApi;
    }
}
