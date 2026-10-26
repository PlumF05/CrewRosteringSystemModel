# 本机 Python / Django 环境

安装日期：2026-10-26。用途：为 CRSM 后续 Python 后端开发准备独立环境。

## 已安装内容

| 项目 | 实际位置/版本 |
| --- | --- |
| 基础 Python | `D:\python\python.exe`，3.12.4 |
| 后端虚拟环境 | `D:\CRSM\backend\.venv` |
| 应使用的解释器 | `D:\CRSM\backend\.venv\Scripts\python.exe` |
| Django | 5.2.18，安装于 `D:\CRSM\backend\.venv\Lib\site-packages\django` |
| pip 缓存 | `D:\CRSM\backend\.venv\.cache\pip`，通过本虚拟环境的 `pip.ini` 配置 |
| 本次安装临时目录 | `D:\CRSM\backend\.venv\.tmp`，仅本次安装进程设置 |
| 安装源 | 官方 PyPI：`https://pypi.org/simple` |

选择项目计划中的 Django 5.2 LTS 分支，安装时解析到 5.2.18；[官方支持信息](https://www.djangoproject.com/download/)。本次只安装 Django 及其必需依赖，版本清单见 `backend/requirements-bootstrap.txt`；后续完整后端仍需确定 DRF、MySQL 驱动、求解器等依赖和项目锁文件。

根目录原有 `.venv` 指向另一套 Python 3.14，不是这里创建的后端环境。当前终端的裸 `python` 命令会优先解析到 Cygwin；运行后端请使用上表中的解释器，IDE 也选择该路径。

## 使用与重建

PowerShell 可以直接执行，不需要先激活环境：

```powershell
& 'D:\CRSM\backend\.venv\Scripts\python.exe' -m django --version
& 'D:\CRSM\backend\.venv\Scripts\python.exe' -m pip check
```

本次输出分别为 `5.2.18` 和 `No broken requirements found.`。

在新的目标目录重建时，先用合适的基础 Python 创建虚拟环境，再用该环境的 Python 安装 `backend/requirements-bootstrap.txt`。不要直接复制 `.venv` 到另一台机器；完整后端建立后，以项目最终依赖锁定方式为准。

## 已验证范围

- Django 导入、版本和安装位置正确，基础解释器、虚拟环境和包目录均位于 D 盘。
- `pip check` 通过，四个安装包无缺失/冲突依赖。
- 临时内存配置的 Django system check 通过。
- Django 测试客户端访问临时 `/health/` 路由返回 HTTP 200，响应包含实际版本。
- 虚拟环境目录已由现有 `.gitignore` 排除；没有修改全局 Python 或系统 PATH。

这些验证确认框架安装正常，不代表 CRSM 后端已开发完成；本次没有创建业务项目、启动常驻服务器、配置 MySQL 连接或执行数据库迁移。
