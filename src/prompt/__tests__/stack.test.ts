import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'crypto'
// loader.ts imports config, which requires ANTHROPIC_API_KEY at load.
vi.hoisted(() => { process.env.ANTHROPIC_API_KEY ??= 'test-key' })
import { detectStacks } from '../stack.js'
import { loadPrompt } from '../loader.js'
import { config } from '../../config.js'
import type { VCSAdapter, PRInfo, ChangedFile } from '../../vcs/adapter.js'

function changed(...paths: string[]): ChangedFile[] {
  return paths.map(p => ({ path: p, status: 'modified' as const }))
}

const addLines = (...lines: string[]) => lines.map(l => `+${l}`).join('\n')

const section = (path: string, ...lines: string[]) =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, '@@ -1,3 +1,9 @@', ...lines].join('\n')

describe('detectStacks bases', () => {
  it('classifies by extension', () => {
    expect(detectStacks(changed('a/B.java', 'a/C.java')).bases).toEqual(['java'])
    expect(detectStacks(changed('A.kt', 'B.kts')).bases).toEqual(['kotlin'])
    expect(detectStacks(changed('app/main.py')).bases).toEqual(['python'])
    expect(detectStacks(changed('src/a.ts', 'src/b.js')).bases).toEqual(['typescript-node'])
    expect(detectStacks(changed('src/App.tsx', 'src/a.ts')).bases).toEqual(['frontend'])
  })

  it('claims plain ts for frontend on a React import in the diff', () => {
    const sel = detectStacks(changed('src/hook.ts', 'src/util.ts'), addLines("import { useState } from 'react'"))
    expect(sel.bases).toEqual(['frontend'])
  })

  it('ignores config, docs, assets and deleted files', () => {
    const files: ChangedFile[] = [
      ...changed('pom.xml', 'README.md', 'package-lock.json', 'logo.png', 'Dockerfile', 'src/A.java'),
      { path: 'old/a.py', status: 'deleted' },
    ]
    expect(detectStacks(files).bases).toEqual(['java'])
  })

  it('returns nothing when nothing classifiable changed', () => {
    expect(detectStacks(changed('README.md', 'config.yml'))).toEqual({ bases: [], overlays: [] })
    expect(detectStacks([])).toEqual({ bases: [], overlays: [] })
  })

  it('injects every base above the floor, largest first', () => {
    const sel = detectStacks(changed('a.py', 'b.py', 'c.py', 'A.java', 'B.java'))
    expect(sel.bases).toEqual(['python', 'java'])
  })

  it('drops bases below the floor and counts unsupported languages against them', () => {
    const files = changed('A.java', 'a.scala', 'b.scala', 'c.scala', 'd.scala', 'e.scala')
    expect(detectStacks(files).bases).toEqual([])
  })

  it('classifies C#, Go, and Rust', () => {
    expect(detectStacks(changed('src/A.cs', 'src/B.cs')).bases).toEqual(['csharp'])
    expect(detectStacks(changed('cmd/main.go', 'util.go')).bases).toEqual(['go'])
    expect(detectStacks(changed('src/lib.rs')).bases).toEqual(['rust'])
  })

  it('counts .razor/.cshtml/.xaml toward the csharp base', () => {
    expect(detectStacks(changed('Pages/Index.razor', 'App.xaml', 'Program.cs')).bases).toEqual(['csharp'])
  })

  it('a Go-dominant PR with a stray web file stays go, not frontend (mis-vote fix)', () => {
    expect(detectStacks(changed('main.go', 'a.go', 'b.go', 'c.go', 'd.go', 'ui/App.tsx')).bases).toEqual(['go'])
  })
})

describe('detectStacks wrapper extensions', () => {
  it('classifies template/sample copies by their inner extension, so docs templates no longer outvote real stacks', () => {
    const templates = Array.from({ length: 9 }, (_, i) => `src/user/t${i}/AGENTS.md.template`)
    const docs = Array.from({ length: 26 }, (_, i) => `docs/d${i}.md`)
    const sel = detectStacks(changed(...templates, ...docs, 'scripts/install.sh', 'tools/find-polluter.sh', 'src/cli.ts'))
    expect(sel.bases).toEqual(['shell', 'typescript-node'])
  })

  it('looks through stacked wrappers and treats a wrapper with no inner extension as neutral', () => {
    expect(detectStacks(changed('config/app.py.in.example')).bases).toEqual(['python'])
    expect(detectStacks(changed('.env.example', 'deploy.template', 'main.go')).bases).toEqual(['go'])
  })
})

describe('detectStacks overlays', () => {
  it('plain java without a spring marker stays generic', () => {
    expect(detectStacks(changed('src/A.java'), addLines('import java.util.List;', '@Service')).overlays).toEqual([])
  })

  it('adds spring from an org.springframework import (java and kotlin)', () => {
    const diff = addLines('import org.springframework.stereotype.Service')
    expect(detectStacks(changed('A.java'), diff)).toEqual({ bases: ['java'], overlays: ['spring'] })
    expect(detectStacks(changed('A.kt'), diff)).toEqual({ bases: ['kotlin'], overlays: ['spring'] })
  })

  it('adds spring from an unambiguous annotation when the import block is outside the hunk', () => {
    expect(detectStacks(changed('A.java'), ' @RestController\n+public class A {}').overlays).toEqual(['spring'])
  })

  it('does not add spring without a jvm base', () => {
    expect(detectStacks(changed('a.py'), addLines('import org.springframework.x')).overlays).toEqual([])
  })

  it('adds angular from a component path, with the frontend base', () => {
    const sel = detectStacks(changed('x.component.ts', 'x.service.ts', 'x.component.html'))
    expect(sel).toEqual({ bases: ['frontend'], overlays: ['angular'] })
  })

  it('adds angular from an @angular import in the diff', () => {
    const sel = detectStacks(changed('x.service.ts'), addLines("import { Injectable } from '@angular/core'"))
    expect(sel).toEqual({ bases: ['frontend'], overlays: ['angular'] })
  })

  it('does not treat NestJS-style .module.ts as angular', () => {
    expect(detectStacks(changed('app.module.ts', 'app.service.ts'))).toEqual({ bases: ['typescript-node'], overlays: [] })
  })

  it('adds ionic from capacitor/ionic imports alongside angular', () => {
    const diff = addLines("import { Camera } from '@capacitor/camera'", "import { Component } from '@angular/core'")
    expect(detectStacks(changed('a.component.ts'), diff).overlays).toEqual(['angular', 'ionic'])
  })

  it('does not add an overlay whose base is below the floor', () => {
    const files = changed('x.component.ts', 'a.py', 'b.py', 'c.py', 'd.py', 'e.py', 'f.py', 'g.py')
    expect(detectStacks(files).overlays).toEqual([])
  })
})

describe('detectStacks .NET overlays', () => {
  it('adds aspnet from an AspNetCore/EF import or a .cshtml path', () => {
    expect(detectStacks(changed('Api.cs'), addLines('using Microsoft.AspNetCore.Mvc;')).overlays).toEqual(['aspnet'])
    expect(detectStacks(changed('Views/Home.cshtml', 'HomeController.cs')).overlays).toContain('aspnet')
  })

  it('adds blazor from a .razor file', () => {
    expect(detectStacks(changed('Pages/Counter.razor', 'App.cs')).overlays).toContain('blazor')
  })

  it('adds maui from a Microsoft.Maui import', () => {
    expect(detectStacks(changed('MainPage.xaml.cs'), addLines('using Microsoft.Maui.Controls;')).overlays).toContain('maui')
  })

  it('adds winforms from System.Windows.Forms', () => {
    expect(detectStacks(changed('Form1.cs'), addLines('using System.Windows.Forms;')).overlays).toContain('winforms')
  })

  it('does not add a .NET overlay without a csharp base', () => {
    expect(detectStacks(changed('a.py'), addLines('using Microsoft.AspNetCore.Mvc;')).overlays).toEqual([])
  })
})

describe('detectStacks round-2 bases', () => {
  it('classifies each new language by extension', () => {
    expect(detectStacks(changed('run.sh', 'lib.bash', 't.bats')).bases).toEqual(['shell'])
    expect(detectStacks(changed('a.php', 'b.phpt')).bases).toEqual(['php'])
    expect(detectStacks(changed('a.c', 'b.cc', 'c.cpp', 'd.cxx', 'e.h', 'f.hpp', 'g.hh')).bases).toEqual(['cpp'])
    expect(detectStacks(changed('A.swift')).bases).toEqual(['swift'])
    expect(detectStacks(changed('main.tf', 'prod.tfvars')).bases).toEqual(['terraform'])
    expect(detectStacks(changed('a.rb')).bases).toEqual(['ruby'])
    expect(detectStacks(changed('lib/main.dart')).bases).toEqual(['dart'])
    expect(detectStacks(changed('x.ps1', 'M.psm1')).bases).toEqual(['powershell'])
  })

  it('counts Jupyter notebooks as python', () => {
    expect(detectStacks(changed('analysis.ipynb')).bases).toEqual(['python'])
  })

  it('classifies an extensionless script as shell from its shebang', () => {
    const diff = ['diff --git a/bin/deploy b/bin/deploy', '--- a/bin/deploy', '+++ b/bin/deploy', '@@ -1 +1,2 @@', '+#!/usr/bin/env bash', '+echo hi'].join('\n')
    expect(detectStacks(changed('bin/deploy'), diff).bases).toEqual(['shell'])
    expect(detectStacks(changed('bin/deploy'), diff.replace('env bash', 'bin/sh')).bases).toEqual(['shell'])
  })

  it('ignores extensionless files without a shell shebang', () => {
    const diff = ['diff --git a/Makefile b/Makefile', '+all:', '+\techo hi'].join('\n')
    expect(detectStacks(changed('Makefile'), diff).bases).toEqual([])
  })

  it('does not attribute a shebang from one file to another', () => {
    const diff = ['diff --git a/run b/run', '+#!/bin/bash', 'diff --git a/LICENSE b/LICENSE', '+text'].join('\n')
    expect(detectStacks(changed('run', 'LICENSE', 'a.py', 'b.py', 'c.py'), diff).bases).toEqual(['python', 'shell'])
  })
})

describe('detectStacks round-2 overlays', () => {
  it('adds laravel from Illuminate import, Model subclass, composer.json or artisan', () => {
    expect(detectStacks(changed('A.php'), addLines('use Illuminate\\Http\\Request;')).overlays).toEqual(['laravel'])
    expect(detectStacks(changed('User.php'), addLines('class User extends Model')).overlays).toEqual(['laravel'])
    expect(detectStacks(changed('a.php', 'composer.json'), addLines('"laravel/framework": "^11.0"')).overlays).toEqual(['laravel'])
    expect(detectStacks(changed('a.php', 'artisan')).overlays).toEqual(['laravel'])
  })

  it('plain php stays generic and laravel needs a php base', () => {
    expect(detectStacks(changed('a.php'), addLines('echo 1;')).overlays).toEqual([])
    expect(detectStacks(changed('a.py'), addLines('use Illuminate\\Http\\Request;')).overlays).toEqual([])
  })

  it('adds rails from controller/record superclass, Rails., routes.rb or Gemfile', () => {
    expect(detectStacks(changed('a.rb'), addLines('class A < ApplicationController')).overlays).toEqual(['rails'])
    expect(detectStacks(changed('a.rb'), addLines('class A < ApplicationRecord')).overlays).toEqual(['rails'])
    expect(detectStacks(changed('a.rb'), addLines('Rails.logger.info(1)')).overlays).toEqual(['rails'])
    expect(detectStacks(changed('a.rb', 'config/routes.rb')).overlays).toEqual(['rails'])
    expect(detectStacks(changed('a.rb', 'Gemfile'), addLines("gem 'rails', '~> 7.1'")).overlays).toEqual(['rails'])
  })

  it('plain ruby stays generic', () => {
    expect(detectStacks(changed('a.rb'), addLines('puts 1')).overlays).toEqual([])
  })

  it('adds android on kotlin or java from manifest, android imports, or gradle plugin', () => {
    expect(detectStacks(changed('A.kt'), addLines('import androidx.fragment.app.Fragment')).overlays).toEqual(['android'])
    expect(detectStacks(changed('A.java'), addLines('import android.os.Bundle;')).overlays).toEqual(['android'])
    expect(detectStacks(changed('A.kt', 'app/src/main/AndroidManifest.xml')).overlays).toEqual(['android'])
    expect(detectStacks(changed('A.kt', 'build.gradle.kts'), addLines('id("com.android.application")')).overlays).toEqual(['android'])
  })

  it('does not treat a bare applicationId as android (too generic — backend code uses that name)', () => {
    expect(detectStacks(changed('Service.java'), addLines('String applicationId = userId;')).overlays).toEqual([])
  })

  it('does not add android without a jvm base', () => {
    expect(detectStacks(changed('a.py', 'AndroidManifest.xml')).overlays).toEqual([])
    expect(detectStacks(changed('A.java'), addLines('import java.util.List;')).overlays).toEqual([])
  })
})

describe('detectStacks VB.NET base', () => {
  it('classifies .vb and .vbhtml as vbnet; VB6 and .vbproj stay other', () => {
    expect(detectStacks(changed('Module1.vb', 'Form1.vb')).bases).toEqual(['vbnet'])
    expect(detectStacks(changed('Views/Home/Index.vbhtml')).bases).toEqual(['vbnet'])
    expect(detectStacks(changed('Mod.bas', 'Form1.frm', 'C.cls'))).toEqual({ bases: [], overlays: [] })
    expect(detectStacks(changed('App.vbproj'))).toEqual({ bases: [], overlays: [] })
  })

  it('counts XAML for vbnet only when the PR has VB and no C#', () => {
    expect(detectStacks(changed('MainWindow.xaml', 'MainWindow.xaml.vb')).bases).toEqual(['vbnet'])
    expect(detectStacks(changed('App.xaml', 'App.xaml.cs')).bases).toEqual(['csharp'])
    expect(detectStacks(changed('A.xaml', 'B.xaml', 'C.vb', 'D.cs')).bases).toEqual(['csharp', 'vbnet'])
  })

  it('leaves WebForms markup classified as before', () => {
    expect(detectStacks(changed('Default.aspx', 'Default.aspx.vb')).bases).toEqual(['vbnet'])
    expect(detectStacks(changed('Default.aspx', 'Default.aspx.cs')).bases).toEqual(['csharp'])
    expect(detectStacks(changed('A.aspx', 'B.aspx', 'C.ascx', 'Site.master', 'Svc.asmx', 'A.aspx.vb')).bases).toEqual([])
  })

  it('injects both bases in a mixed C#/VB PR, largest first, C# on a tie', () => {
    expect(detectStacks(changed('A.cs', 'B.cs', 'C.vb')).bases).toEqual(['csharp', 'vbnet'])
    expect(detectStacks(changed('A.vb', 'B.vb', 'C.cs')).bases).toEqual(['vbnet', 'csharp'])
    expect(detectStacks(changed('A.cs', 'B.vb')).bases).toEqual(['csharp', 'vbnet'])
  })
})

describe('detectStacks VB.NET overlays', () => {
  it('adds winforms from a form designer, a Forms/WPF import or a Form base class', () => {
    expect(detectStacks(changed('Form1.Designer.vb', 'Form1.vb'))).toEqual({ bases: ['vbnet'], overlays: ['winforms'] })
    expect(detectStacks(changed('Form1.vb'), addLines('Imports System.Windows.Forms')).overlays).toEqual(['winforms'])
    expect(detectStacks(changed('MainWindow.xaml.vb'), addLines('Imports System.Windows.Controls')).overlays).toEqual(['winforms'])
    expect(detectStacks(changed('Form1.vb'), ' Partial Class Form1\n+    Inherits System.Windows.Forms.Form').overlays).toEqual(['winforms'])
  })

  it('does not treat the project resource/settings designers as WinForms', () => {
    for (const p of ['My Project/Resources.Designer.vb', 'My Project/Settings.Designer.vb', 'My Project/Application.Designer.vb']) {
      expect(detectStacks(changed(p))).toEqual({ bases: ['vbnet'], overlays: [] })
    }
  })

  it('adds aspnet from an AspNetCore import, a VB attribute, a controller base class or a .vbhtml view', () => {
    expect(detectStacks(changed('Api.vb'), addLines('Imports Microsoft.AspNetCore.Mvc')).overlays).toEqual(['aspnet'])
    expect(detectStacks(changed('Api.vb'), addLines('    <HttpGet("{id}")>')).overlays).toEqual(['aspnet'])
    expect(detectStacks(changed('Api.vb'), addLines('    Inherits ControllerBase')).overlays).toEqual(['aspnet'])
    expect(detectStacks(changed('Views/Home/Index.vbhtml', 'HomeController.vb')).overlays).toEqual(['aspnet'])
  })

  it('never adds blazor or maui on VB, and VB markers do not touch a C# base', () => {
    expect(detectStacks(changed('A.vb'), addLines('Imports Microsoft.Maui.Controls')).overlays).toEqual([])
    expect(detectStacks(changed('A.vb'), addLines('@rendermode InteractiveServer')).overlays).toEqual([])
    expect(detectStacks(changed('Counter.vb'), addLines('Imports Microsoft.AspNetCore.Components')).overlays).toEqual(['aspnet'])
    expect(detectStacks(changed('A.cs'), addLines('    <HttpGet("{id}")>', '    Inherits ControllerBase')).overlays).toEqual([])
  })

  it('a mixed C#/VB PR takes overlays from either language', () => {
    expect(detectStacks(changed('A.cs', 'B.vb'), addLines('Imports System.Windows.Forms')).overlays).toEqual(['winforms'])
    expect(detectStacks(changed('A.cs', 'B.vb'), addLines('using Microsoft.AspNetCore.Mvc;')).overlays).toEqual(['aspnet'])
  })
})

describe('detectStacks SQL Server overlay', () => {
  const sqlserver = (paths: string[], diff: string) => detectStacks(changed(...paths), diff).overlays.includes('sqlserver')

  it('triggers on SQL Server client APIs and T-SQL syntax under C# or VB', () => {
    expect(sqlserver(['A.cs'], addLines('using Microsoft.Data.SqlClient;'))).toBe(true)
    expect(sqlserver(['A.vb'], addLines('Imports System.Data.SqlClient'))).toBe(true)
    expect(sqlserver(['A.cs'], addLines('using var cmd = new SqlCommand(sql, conn);'))).toBe(true)
    expect(sqlserver(['Startup.cs'], addLines('options.UseSqlServer(cs);'))).toBe(true)
    expect(sqlserver(['A.cs', 'A.csproj'], addLines('    <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="8.0.0" />'))).toBe(true)
    expect(sqlserver(['M.cs'], addLines('    .Annotation("SqlServer:Identity", "1, 1"),'))).toBe(true)
    expect(sqlserver(['A.vb'], section('A.vb', '+Dim sql = "SELECT Id FROM Users WITH (NOLOCK)"', '+cmd.CommandText = sql', '+Dim c = New NpgsqlConnection(cs)'))).toBe(true)
    expect(sqlserver(['M.cs'], section('M.cs', '+    type: "nvarchar(max)", nullable: true),', '+using Npgsql;'))).toBe(true)
  })

  it('counts TOP, [dbo] and dbo. only as provider-neutral SQL, since Access and migrated schemas use them', () => {
    expect(sqlserver(['A.vb'], section('A.vb', '+Dim sql = "SELECT TOP 10 * FROM [dbo].[Users]"'))).toBe(true)
    expect(sqlserver(['A.vb'], section('A.vb', '+Dim sql = "SELECT TOP 10 * FROM [dbo].[Users]"', '+Dim c = New OracleConnection(cs)'))).toBe(false)
  })

  it('triggers on a T-SQL .sql script, even beside another client, since that script is SQL Server-only', () => {
    expect(sqlserver(['A.cs', 'db/001.sql'], section('db/001.sql', '+create table dbo_users (id int)', '+go'))).toBe(true)
    expect(sqlserver(['A.cs', 'db/001.sql'], addLines('using Npgsql;') + '\n' + section('db/001.sql', '+create table users (id int)', '+GO'))).toBe(true)
  })

  it('triggers on provider-neutral raw SQL once .NET is recognised', () => {
    expect(sqlserver(['A.cs'], section('A.cs', '+var users = await conn.QueryAsync<User>("SELECT Id FROM Users WHERE Id = @Id", new { Id = id });'))).toBe(true)
    expect(sqlserver(['A.vb'], section('A.vb', '+Dim sql = $"UPDATE Users SET Name = @Name WHERE Id = {id}"'))).toBe(true)
    expect(sqlserver(['A.cs'], addLines('await connection.ExecuteAsync(insertSql, user);'))).toBe(true)
    expect(sqlserver(['A.cs'], addLines('using Dapper;'))).toBe(true)
    expect(sqlserver(['A.vb'], addLines('Imports Dapper'))).toBe(true)
    expect(sqlserver(['A.cs'], addLines('var rows = db.Users.FromSqlRaw("SELECT Id FROM Users").ToList();'))).toBe(true)
    expect(sqlserver(['A.cs'], addLines('await db.Database.ExecuteSqlRawAsync(sql);'))).toBe(true)
    expect(sqlserver(['A.cs'], addLines('var ids = db.Database.SqlQuery<int>($"SELECT Id FROM Users");'))).toBe(true)
    expect(sqlserver(['A.vb'], addLines('cmd.CommandText = sql'))).toBe(true)
    expect(sqlserver(['A.cs'], addLines('public Repo(IDbConnection db) => _db = db;'))).toBe(true)
    expect(sqlserver(['A.cs'], addLines('await using DbCommand cmd = conn.CreateCommand();'))).toBe(true)
    expect(sqlserver(['A.cs', 'db/q.sql'], section('db/q.sql', '+select id from users where active = 1;'))).toBe(true)
  })

  it('finds SQL inside a multi-line string literal, and C# syntax that looks like another dialect does not veto it', () => {
    const multiLine = section('Repo.cs', '         const string sql = @"', '+            SELECT u.Id, u.Name', '             FROM Users u";')
    expect(sqlserver(['Repo.cs'], multiLine)).toBe(true)
    const rawInterpolated = section('Repo.cs', '+var sql = $$"""SELECT Id FROM Users WHERE Id = {{id}}""";', '+#pragma warning disable CS0618', '+var engine = new Engine();')
    expect(sqlserver(['Repo.cs'], rawInterpolated)).toBe(true)
  })

  it('does not trigger when the diff shows another database', () => {
    const neutral = 'var rows = db.Users.FromSqlRaw("SELECT Id FROM Users").ToList();'
    for (const other of ['using Npgsql;', 'options.UseNpgsql(cs);', 'using var c = new MySqlConnection(cs);', 'options.UseMySql(cs, ServerVersion.AutoDetect(cs));',
      'using var c = new SqliteConnection(cs);', 'options.UseSqlite(cs);', 'var c = new SQLiteConnection(path);', 'var db = new SQLiteAsyncConnection(path);',
      'using var c = new OracleConnection(cs);', 'options.UseOracle(cs);', '    <PackageReference Include="Pomelo.EntityFrameworkCore.MySql" Version="8.0.0" />']) {
      expect(sqlserver(['A.cs'], addLines(other, neutral))).toBe(false)
    }
  })

  it('does not trigger when SQL text uses another dialect', () => {
    expect(sqlserver(['A.cs', 'db/m.sql'], section('db/m.sql', '+select id from users', '+LIMIT 10;', '+GO'))).toBe(false)
    expect(sqlserver(['A.cs', 'db/m.sql'], section('db/m.sql', '+CREATE TABLE users (id SERIAL PRIMARY KEY);'))).toBe(false)
    const run = '+cmd.CommandText = sql;'
    expect(sqlserver(['A.cs'], section('A.cs', '+var sql = "SELECT id FROM users LIMIT 10";', run))).toBe(false)
    expect(sqlserver(['A.cs'], section('A.cs', '+    INSERT INTO users (id) VALUES (@Id)', '+    ON CONFLICT (id) DO NOTHING";', run))).toBe(false)
    expect(sqlserver(['A.cs'], section('A.cs', '+var sql = "SELECT `id` FROM `users`";', run))).toBe(false)
    expect(sqlserver(['A.cs'], section('A.cs', '+var sql = "SELECT id FROM users WHERE active = 1 limit 10";', run))).toBe(false)
    expect(sqlserver(['A.cs'], section('A.cs', '+var sql = "SELECT id FROM users WHERE active = 1";', run))).toBe(true)
  })

  it('does not trigger on English text, UI labels or removed lines', () => {
    const prose = section('A.cs', '+// Select top rated items from the update queue', '+ShowMessage("Please select an item from the list");',
      '+button.Text = "SELECT ALL";', '+banner.Text = "UPDATE AVAILABLE";', '+label.Text = "Delete from favorites";', '+// SELECT the newest row first',
      '+var name = "x"; // SELECT a, b FROM t')
    expect(sqlserver(['A.cs'], prose)).toBe(false)
    expect(sqlserver(['A.cs'], '-using Microsoft.Data.SqlClient;\n-var c = new SqlConnection(cs);\n+var c = Create();')).toBe(false)
  })

  it('needs a recognised .NET base', () => {
    expect(detectStacks(changed('a.py'), addLines('conn = SqlConnection(cs)')).overlays).toEqual([])
    expect(detectStacks(changed('a.ts'), addLines('const q = "SELECT Id FROM Users WHERE Id = @Id"'))).toEqual({ bases: ['typescript-node'], overlays: [] })
    expect(detectStacks(changed('db/001.sql'), section('db/001.sql', '+SELECT TOP 10 * FROM [dbo].[Users]', '+GO'))).toEqual({ bases: [], overlays: [] })
  })

  it('comes after the framework overlays', () => {
    const diff = addLines('using Microsoft.AspNetCore.Mvc;', 'using Microsoft.Data.SqlClient;')
    expect(detectStacks(changed('HomeController.cs'), diff)).toEqual({ bases: ['csharp'], overlays: ['aspnet', 'sqlserver'] })
    expect(detectStacks(changed('Form1.Designer.vb', 'Form1.vb'), addLines('Imports System.Data.SqlClient'))).toEqual({ bases: ['vbnet'], overlays: ['winforms', 'sqlserver'] })
  })
})

describe('detectStacks VBScript base', () => {
  it('classifies classic ASP and WSH files as vbscript', () => {
    for (const p of ['default.asp', 'global.asa', 'tools/cleanup.vbs', 'jobs/nightly.wsf']) {
      expect(detectStacks(changed(p)).bases).toEqual(['vbscript'])
    }
  })

  it('keeps .aspx and the other WebForms files apart from .asp', () => {
    expect(detectStacks(changed('Default.aspx'))).toEqual({ bases: [], overlays: [] })
    expect(detectStacks(changed('default.asp'))).toEqual({ bases: ['vbscript'], overlays: [] })
    expect(detectStacks(changed('A.ascx', 'Site.master', 'Svc.asmx', 'H.ashx', 'Global.asax'))).toEqual({ bases: [], overlays: [] })
  })

  it('leaves .inc as other', () => {
    expect(detectStacks(changed('includes/header.inc'))).toEqual({ bases: [], overlays: [] })
    expect(detectStacks(changed('a.inc', 'b.inc', 'c.inc', 'd.inc', 'e.inc', 'default.asp')).bases).toEqual([])
  })

  it('composes with other bases by vote, and .vbs never counts as VB.NET', () => {
    expect(detectStacks(changed('A.vb', 'B.vb', 'c.vbs')).bases).toEqual(['vbnet', 'vbscript'])
    expect(detectStacks(changed('a.vbs', 'b.vbs', 'C.vb')).bases).toEqual(['vbscript', 'vbnet'])
    expect(detectStacks(changed('src/A.cs', 'src/B.cs', 'tools/deploy.vbs')).bases).toEqual(['csharp', 'vbscript'])
    expect(detectStacks(changed('MainWindow.xaml', 'x.vbs')).bases).toEqual(['csharp', 'vbscript'])
    expect(detectStacks(changed('Form1.vbs'), addLines('Imports System.Windows.Forms')).overlays).toEqual([])
  })
})

describe('detectStacks SQL Server overlay on classic ASP', () => {
  const sqlserver = (paths: string[], diff: string) => detectStacks(changed(...paths), diff).overlays.includes('sqlserver')
  const asp = (...lines: string[]) => section('default.asp', ...lines.map(l => `+${l}`))

  it('triggers on SQL Server OLE DB providers and ODBC drivers', () => {
    for (const cs of ['Provider=SQLOLEDB;Data Source=db01', 'Provider=SQLOLEDB.1;Data Source=db01', 'Provider=MSOLEDBSQL19;Server=db01', 'Provider=SQLNCLI11;Server=db01',
      'Driver={SQL Server};Server=db01', 'Driver={ODBC Driver 17 for SQL Server};Server=db01', 'driver={sql server native client 11.0};server=db01']) {
      expect(sqlserver(['default.asp'], asp(`conn.Open "${cs}"`))).toBe(true)
    }
  })

  it('triggers on ADODB objects and on Execute/Open with SQL', () => {
    expect(sqlserver(['default.asp'], asp('Set conn = Server.CreateObject("ADODB.Connection")'))).toBe(true)
    expect(sqlserver(['default.asp'], asp('Set rs = conn.Execute("select id from users where id=" & id)'))).toBe(true)
    expect(sqlserver(['default.asp'], asp('rs.Open strSQL, conn, 1, 3'))).toBe(true)
    expect(sqlserver(['default.asp'], asp('conn.Execute sql'))).toBe(true)
  })

  it('scans SQL strings in .vbs, .wsf and .asa, but not in .asp markup', () => {
    expect(sqlserver(['tools/purge.vbs'], section('tools/purge.vbs', '+sql = "DELETE FROM Sessions WHERE Expired = 1"'))).toBe(true)
    expect(sqlserver(['jobs/a.wsf'], section('jobs/a.wsf', '+  sql = "SELECT Id, Name FROM Users"'))).toBe(true)
    expect(sqlserver(['global.asa'], section('global.asa', '+  sql = "UPDATE Stats SET Hits = 0"'))).toBe(true)
    expect(sqlserver(['default.asp'], asp('<button title="DELETE FROM CART">Remove</button>', '<option value="x">SELECT ALL, NONE</option>'))).toBe(false)
  })

  it('does not trigger with Access, MySQL or Oracle', () => {
    const adodb = 'Set conn = Server.CreateObject("ADODB.Connection")'
    for (const other of ['conn.Open "Provider=Microsoft.Jet.OLEDB.4.0;Data Source=" & Server.MapPath("db/app.mdb")', 'conn.Open "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=c:\\data\\app.accdb"',
      'conn.Open "Driver={Microsoft Access Driver (*.mdb)};DBQ=" & dbPath', 'conn.Open "Driver={MySQL ODBC 8.0 Unicode Driver};Server=db01"',
      'conn.Open "Provider=OraOLEDB.Oracle;Data Source=orcl"', 'conn.Open "Provider=MSDAORA;Data Source=orcl"']) {
      expect(sqlserver(['default.asp'], asp(adodb, other))).toBe(false)
    }
    expect(sqlserver(['default.asp', 'db/app.mdb'], asp(adodb))).toBe(false)
    expect(sqlserver(['tools/a.vbs'], section('tools/a.vbs', '+sql = "SELECT id FROM users LIMIT 10"', '+conn.Execute sql'))).toBe(false)
  })

  it('a SQL Server provider still counts beside an Access file, and a plain page or another base gets nothing', () => {
    expect(sqlserver(['default.asp', 'db/old.mdb'], asp('conn.Open "Provider=SQLOLEDB;Data Source=db01"'))).toBe(true)
    expect(sqlserver(['default.asp'], asp('xhr.Open "GET", url, False', 'conn.Open connStr', 'Response.Write "SELECT a, b FROM t"'))).toBe(false)
    expect(detectStacks(changed('a.ts'), addLines('const cs = "Provider=SQLOLEDB;Data Source=db01"')).overlays).toEqual([])
    expect(detectStacks(changed('includes/db.inc'), addLines('Set conn = Server.CreateObject("ADODB.Connection")'))).toEqual({ bases: [], overlays: [] })
  })

  it('labels the overlay after the base and counts the providers on .NET too', () => {
    expect(detectStacks(changed('default.asp'), asp('conn.Open "Provider=SQLOLEDB;Data Source=db01"'))).toEqual({ bases: ['vbscript'], overlays: ['sqlserver'] })
    expect(sqlserver(['Legacy.cs'], addLines('var cs = "Provider=SQLOLEDB;Data Source=db01";'))).toBe(true)
  })
})

describe('detectStacks SQL Server overlay: false triggers and false vetoes', () => {
  const sqlserver = (paths: string[], diff: string) => detectStacks(changed(...paths), diff).overlays.includes('sqlserver')

  it('a C#-only PR without SQL stays stack:csharp', () => {
    const cases: [string[], string][] = [
      [['src/A.cs'], section('src/A.cs', '+var p = process.Execute("update --check");')],
      [['src/A.cs'], section('src/A.cs', '+dialog.Open("delete-confirm");')],
      [['src/A.cs'], section('src/A.cs', '+await _jobs.Execute("update", payload);')],
      [['src/A.cs'], section('src/A.cs', '+using var f = File.Open(sqlitePath, FileMode.Open);')],
      [['src/A.cs'], section('src/A.cs', '+label.Text = "SELECT ITEMS FROM LIST";', '+hint.Text = "PLEASE SELECT ONE, OR MORE";', '+cmd.Text = "EXECUTE ORDER";', '+button.Text = "DELETE FROM CART";')],
      [['src/A.cs'], section('src/A.cs', '+button.Text = "DELETE FROM CART...";')],
      [['src/A.cs'], section('src/A.cs', '+label.Text = "SELECT ITEMS FROM LIST (OPTIONAL)";')],
      [['src/A.cs'], section('src/A.cs', '+var s = "a\\"b"; // UPDATE t SET x = 1', '+var q = \'"\'; // SELECT a, b FROM t', '+// ShowMessage("SELECT a, b FROM t")')],
      [['src/A.cs', 'docs/SqlConnection.md'], section('src/A.cs', '+var x = 1;') + '\n' + section('docs/SqlConnection.md', '+Open a SqlConnection, then run SELECT TOP 10 * FROM dbo.Users WITH (NOLOCK).')],
      [['Errors/SqlException.cs'], section('Errors/SqlException.cs', '+public sealed class AppFailure : Exception { }')],
    ]
    for (const [paths, diff] of cases) expect(detectStacks(changed(...paths), diff)).toEqual({ bases: ['csharp'], overlays: [] })
    expect(sqlserver(['src/A.cs', 'wwwroot/js/site.js'], section('wwwroot/js/site.js', '+modal.open("update-profile");'))).toBe(false)
  })

  it('counts all-caps SQL only when its punctuation is SQL-shaped', () => {
    expect(sqlserver(['A.cs'], section('A.cs', '+var sql = "SELECT ID, NAME FROM USERS";'))).toBe(true)
    expect(sqlserver(['A.cs'], section('A.cs', '+var sql = "DELETE FROM USERS WHERE ID = 1";'))).toBe(true)
    expect(sqlserver(['A.cs'], section('A.cs', '+var sql = "INSERT INTO LOGS(MSG) VALUES(1)";'))).toBe(true)
  })

  it('lexes C# raw strings of any delimiter length and git-quoted file names', () => {
    expect(detectStacks(changed('A.cs'), section('A.cs', '+var message = """"This contains """ quotes"""";', '+// SqlConnection is deliberately unsupported here.'))).toEqual({ bases: ['csharp'], overlays: [] })
    const quoted = (body: string) => ['diff --git "a/\\303\\251.cs" "b/\\303\\251.cs"', '--- "a/\\303\\251.cs"', '+++ "b/\\303\\251.cs"', '@@ -1 +1 @@', body].join('\n')
    expect(detectStacks(changed('é.cs'), quoted('+var x = 1; // SqlConnection is not used here'))).toEqual({ bases: ['csharp'], overlays: [] })
    expect(detectStacks(changed('docs/readme.md', 'é.cs'), section('docs/readme.md', '+Notes.') + '\n' + quoted('+using Microsoft.Data.SqlClient;')).overlays).toEqual(['sqlserver'])
  })

  it('a column or value named like another dialect, or a comment, does not veto', () => {
    expect(sqlserver(['A.cs'], section('A.cs', '+var rows = await db.QueryAsync<Part>("SELECT Id FROM Parts WHERE Serial = @s", new { s });'))).toBe(true)
    expect(sqlserver(['A.cs'], section('A.cs', '+await db.ExecuteAsync(updateSql, new { Engine = e });'))).toBe(true)
    expect(sqlserver(['A.cs', 'db/1.sql'], section('db/1.sql', '+ALTER TABLE Parts ADD Serial NVARCHAR(50);'))).toBe(true)
    expect(sqlserver(['A.cs', 'db/1.sql'], section('db/1.sql', "+UPDATE Cars SET Engine = 'V8';", '+-- limit 10 rows per page'))).toBe(true)
    expect(sqlserver(['A.vb'], section('A.vb', '+Dim sql = "SELECT Id FROM Parts" \' limit 100', '+cmd.CommandText = sql'))).toBe(true)
    expect(sqlserver(['A.cs'], section('A.cs', '+var sql = "SELECT Id FROM Notes WHERE Body = \'limit 10\'";', '+cmd.CommandText = sql;'))).toBe(true)
  })

  it('syntax another engine shares is not SQL Server-only, and a dialect in a .sql section cancels its T-SQL', () => {
    const access = section('default.asp', '+conn.Open "Provider=Microsoft.ACE.OLEDB.12.0;Data Source=c:\\data\\app.accdb"', '+Set rs = conn.Execute("SELECT TOP 10 Id FROM Users")')
    expect(sqlserver(['default.asp'], access)).toBe(false)
    expect(sqlserver(['A.cs', 'q.sql'], section('q.sql', '+SELECT id FROM dbo.users LIMIT 10;'))).toBe(false)
    expect(sqlserver(['A.cs', 'q.sql'], section('q.sql', '+SET NOCOUNT ON;', '+SELECT id FROM users LIMIT 10;'))).toBe(false)
    expect(sqlserver(['A.cs'], section('A.cs', '+using Microsoft.Data.SqlClient;', '+using Npgsql;'))).toBe(true)
  })

  it('checks ADODB call strings for another dialect in any case', () => {
    expect(sqlserver(['default.asp'], section('default.asp', '+Set conn = Server.CreateObject("ADODB.Connection")', '+Set rs = conn.Execute("select id from users limit 10")'))).toBe(false)
  })

  it('takes global.json as a .NET signal only at the repo root', () => {
    const tsql = section('db/001.sql', '+SET XACT_ABORT ON;', '+GO')
    expect(detectStacks(changed('src/i18n/global.json', 'db/001.sql'), tsql)).toEqual({ bases: [], overlays: [] })
    expect(detectStacks(changed('global.json', 'db/001.sql'), tsql)).toEqual({ bases: ['csharp'], overlays: ['sqlserver'] })
  })

  it('stays linear on 1 MB lines and on many long lines', () => {
    const mb = 1_000_000
    const cases: [string[], string][] = [
      [['A.cs'], section('A.cs', '+// SELECT TOP' + ' '.repeat(mb) + 'x')],
      [['A.cs'], section('A.cs', '+var x = obj.Query(' + 'sql'.repeat(mb / 3) + ' + suffix);')],
      [['A.cs'], section('A.cs', '+var s = "SELECT ' + 'a, '.repeat(mb / 3) + '";')],
      [['A.cs'], '+var s = "UPDATE ' + 'a'.repeat(mb) + ' SET x = 1";'],
      [['A.cs', 'q.sql'], section('q.sql', '+' + 'SELECT a FROM t WHERE x = 1 AND '.repeat(mb / 32))],
      [['default.asp'], section('default.asp', '+conn.Execute("select ' + 'a, '.repeat(mb / 3) + '")')],
      [['a.vbs'], section('a.vbs', '+sql = "SELECT ' + '(,'.repeat(mb / 2) + '"')],
      [['A.cs'], section('A.cs', ...Array.from({ length: 500 }, () => '+var s = @"SELECT ' + '(id, '.repeat(399) + '";'))],
      [['A.cs'], section('A.cs', ...Array.from({ length: 500 }, () => '+x.Execute(' + 'a'.repeat(1990) + ')'))],
      [['A.cs', 'q.sql'], section('q.sql', ...Array.from({ length: 500 }, () => '+(' + 'a, '.repeat(660)))],
      [['A.cs', 'q.sql'], section('q.sql', ...Array.from({ length: 8000 }, () => '+' + ' '.repeat(80)), '+!')],
      [['A.cs', 'q.sql'], section('A.cs', ...Array.from({ length: 8000 }, () => ' ' + ' '.repeat(80)), '+!')],
    ]
    for (const [paths, diff] of cases) {
      // Best of three: parallel test files slow single runs, a quadratic scan slows all three
      const runs = [0, 1, 2].map(() => { const start = performance.now(); detectStacks(changed(...paths), diff); return performance.now() - start })
      expect(Math.min(...runs)).toBeLessThan(200)
    }
  })
})

describe('detectStacks .sql files and .NET project files', () => {
  const tsql = (path: string) => section(path, '+CREATE OR ALTER PROCEDURE dbo.GetUsers AS SELECT Id FROM dbo.Users', '+GO')

  it('.sql files never vote', () => {
    const scripts = ['1', '2', '3', '4', '5'].map(n => `db/${n}.sql`)
    expect(detectStacks(changed('A.cs', ...scripts), scripts.map(tsql).join('\n'))).toEqual({ bases: ['csharp'], overlays: ['sqlserver'] })
    expect(detectStacks(changed('a.ts', 'db/1.sql'), tsql('db/1.sql'))).toEqual({ bases: ['typescript-node'], overlays: [] })
  })

  it('recognises a code-less migration PR as .NET from its project file when it changes SQL', () => {
    expect(detectStacks(changed('Db.csproj', 'Scripts/0042.sql'), tsql('Scripts/0042.sql'))).toEqual({ bases: ['csharp'], overlays: ['sqlserver'] })
    expect(detectStacks(changed('Db.vbproj', 'Scripts/0042.sql'), tsql('Scripts/0042.sql'))).toEqual({ bases: ['vbnet'], overlays: ['sqlserver'] })
    expect(detectStacks(changed('Db.sqlproj', 'Tables/Users.sql'), tsql('Tables/Users.sql'))).toEqual({ bases: ['csharp'], overlays: ['sqlserver'] })
    expect(detectStacks(changed('global.json', 'Scripts/1.sql'), tsql('Scripts/1.sql'))).toEqual({ bases: ['csharp'], overlays: ['sqlserver'] })
    expect(detectStacks(changed('Db.csproj', 'Scripts/1.sql'), section('Scripts/1.sql', '+select id from users;'))).toEqual({ bases: ['csharp'], overlays: ['sqlserver'] })
  })

  it('picks the base from the votes when code sits below the floor', () => {
    const projects = ['A.csproj', 'B.csproj', 'C.csproj', 'D.csproj', 'E.csproj']
    expect(detectStacks(changed('A.cs', ...projects, 'db/1.sql'), tsql('db/1.sql'))).toEqual({ bases: ['csharp'], overlays: ['sqlserver'] })
    expect(detectStacks(changed('A.vb', ...projects, 'db/1.sql'), tsql('db/1.sql'))).toEqual({ bases: ['vbnet'], overlays: ['sqlserver'] })
  })

  it('stays generic without a SQL signal, with another dialect, or with non-.NET source', () => {
    expect(detectStacks(changed('Db.csproj', 'Directory.Packages.props'))).toEqual({ bases: [], overlays: [] })
    expect(detectStacks(changed('Db.csproj', 'm.sql'), section('m.sql', '+CREATE TABLE users (id SERIAL PRIMARY KEY);'))).toEqual({ bases: [], overlays: [] })
    expect(detectStacks(changed('a.scala', 'Db.csproj', 'db/1.sql'), tsql('db/1.sql'))).toEqual({ bases: [], overlays: [] })
  })
})

const PR: PRInfo = {
  id: '1', title: 'Test', description: '', author: 'dev',
  sourceBranch: 'feature/x', targetBranch: 'develop', sourceCommit: 'abc123def456',
}

function adapterWith(files: Record<string, string>): VCSAdapter {
  return { getRepoFileContent: vi.fn(async (path: string) => files[path] ?? null) } as unknown as VCSAdapter
}

describe('loadPrompt stack composition', () => {
  it('uses the generic java base for plain java', async () => {
    const result = await loadPrompt(adapterWith({}), PR, undefined, changed('src/A.java'), addLines('import java.util.List;'))

    expect(result.source).toBe('stack:java')
    expect(result.content).toContain('Senior Backend Architect')
    expect(result.content).not.toContain('Spring / JPA Specifics')
  })

  it('layers the spring overlay on the java base', async () => {
    const diff = addLines('import org.springframework.stereotype.Service')

    const result = await loadPrompt(adapterWith({}), PR, undefined, changed('src/A.java'), diff)

    expect(result.source).toBe('stack:java+spring')
    expect(result.content).toContain('Senior Backend Architect')
    expect(result.content).toContain('Spring / JPA Specifics')
    expect(result.content).toContain('@MockBean')
  })

  it('composes multiple bases with one role and de-duplicated shared lines', async () => {
    const result = await loadPrompt(adapterWith({}), PR, undefined, changed('a.py', 'b.py', 'A.java'))

    expect(result.source).toBe('stack:python+java')
    expect(result.content).toContain('Senior Python Engineer')
    expect(result.content).not.toContain('Senior Backend Architect')
    expect(result.content).toContain('Ignore System.out')
    const todoLine = 'Do not flag new methods/functions with no callers in the diff if they have a TODO/FIXME comment indicating upcoming work'
    expect(result.content.split(todoLine).length - 1).toBe(1)
  })

  it('composes frontend + angular + ionic', async () => {
    const diff = addLines("import { Camera } from '@capacitor/camera'")

    const result = await loadPrompt(adapterWith({}), PR, undefined, changed('a.component.ts'), diff)

    expect(result.source).toBe('stack:frontend+angular+ionic')
    expect(result.content).toContain('Senior Frontend Architect')
    expect(result.content).toContain('Angular Specifics')
    expect(result.content).toContain('Ionic / Mobile Specifics')
    expect(result.content).not.toContain('{{')
  })

  it('falls back to the default prompt when nothing is detected', async () => {
    const result = await loadPrompt(adapterWith({}), PR, undefined, changed('README.md', 'a.scala'))

    expect(result.source).toBe('default')
  })

  it('layers the aspnet overlay on the csharp base', async () => {
    const result = await loadPrompt(adapterWith({}), PR, undefined, changed('HomeController.cs'), addLines('using Microsoft.AspNetCore.Mvc;'))

    expect(result.source).toBe('stack:csharp+aspnet')
    expect(result.content).toContain('Senior .NET Engineer')
    expect(result.content).toContain('ASP.NET Core / EF Core Specifics')
    expect(result.content).not.toContain('{{')
  })

  it('composes the vbnet base and the sqlserver overlay, labelled in push order', async () => {
    const vb = await loadPrompt(adapterWith({}), PR, undefined, changed('Module1.vb'))
    expect(vb.source).toBe('stack:vbnet')
    expect(vb.content).toContain('reviewing VB.NET')
    expect(vb.content).toContain('`IIf(...)` evaluates both branches')
    expect(vb.content).not.toContain('{{')

    const forms = await loadPrompt(adapterWith({}), PR, undefined, changed('Form1.Designer.vb', 'Form1.vb'))
    expect(forms.source).toBe('stack:vbnet+winforms')
    expect(forms.content).toContain('WinForms / WPF Desktop Specifics')
    expect(forms.content).not.toContain('{{')

    const web = await loadPrompt(adapterWith({}), PR, undefined, changed('HomeController.cs'), addLines('using Microsoft.AspNetCore.Mvc;', 'using Microsoft.Data.SqlClient;'))
    expect(web.source).toBe('stack:csharp+aspnet+sqlserver')
    expect(web.content.indexOf('ASP.NET Core / EF Core Specifics')).toBeLessThan(web.content.indexOf('SQL Server / T-SQL Specifics'))
    expect(web.content).toContain('Do not flag `SELECT *` inside `EXISTS (…)`')
    expect(web.content).not.toContain('{{')

    const migration = await loadPrompt(adapterWith({}), PR, undefined, changed('Db.csproj', 'Scripts/1.sql'), section('Scripts/1.sql', '+SET XACT_ABORT ON', '+GO'))
    expect(migration.source).toBe('stack:csharp+sqlserver')
  })

  it('a mixed C#/VB PR takes ROLE from the larger base and keeps shared bullets once', async () => {
    const mixed = await loadPrompt(adapterWith({}), PR, undefined, changed('A.cs', 'B.cs', 'C.vb'))
    expect(mixed.source).toBe('stack:csharp+vbnet')
    expect(mixed.content).toContain('You are a Senior .NET Engineer and Production Gatekeeper.')
    expect(mixed.content).not.toContain('reviewing VB.NET')
    expect(mixed.content).toContain('`IIf(...)` evaluates both branches')
    expect(mixed.content.split('Logic changes that alter business invariants').length - 1).toBe(1)

    const vbFirst = await loadPrompt(adapterWith({}), PR, undefined, changed('A.vb', 'B.vb', 'C.cs'))
    expect(vbFirst.source).toBe('stack:vbnet+csharp')
    expect(vbFirst.content).toContain('reviewing VB.NET')
  })

  it('composes the vbscript base, alone, with sqlserver, and mixed with vbnet', async () => {
    const page = await loadPrompt(adapterWith({}), PR, undefined, changed('default.asp'))
    expect(page.source).toBe('stack:vbscript')
    expect(page.content).toContain('reviewing classic ASP and VBScript')
    expect(page.content).toContain('`CreateParameter`')
    expect(page.content).not.toContain('{{')

    const db = await loadPrompt(adapterWith({}), PR, undefined, changed('default.asp'), section('default.asp', '+conn.Open "Provider=SQLOLEDB;Data Source=db01"'))
    expect(db.source).toBe('stack:vbscript+sqlserver')
    expect(db.content).toContain('SQL Server / T-SQL Specifics')
    expect(db.content).toContain('read its ADO.NET types as their ADODB equivalents')
    expect(db.content).not.toContain('{{')

    const mixed = await loadPrompt(adapterWith({}), PR, undefined, changed('A.vb', 'B.vb', 'c.vbs'))
    expect(mixed.source).toBe('stack:vbnet+vbscript')
    expect(mixed.content).toContain('reviewing VB.NET')
    expect(mixed.content).not.toContain('reviewing classic ASP')
    expect(mixed.content.split('Production service under real load').length - 1).toBe(1)
  })

  it('scopes language-only exceptions by wording so they do not reach the other base of a mixed PR', async () => {
    const mixed = await loadPrompt(adapterWith({}), PR, undefined, changed('src/A.cs', 'src/B.cs', 'tools/deploy.vbs'))
    expect(mixed.source).toBe('stack:csharp+vbscript')
    const exceptions = mixed.content.split('\n').filter(l => /^- (Do not|In .* files, do not)/.test(l))
    for (const leak of ['ask for unit tests', 'migrating to ASP.NET', 'Hungarian notation', 'string concatenation', '`On Error Resume Next`']) {
      expect(exceptions.filter(l => l.includes(leak)).every(l => l.startsWith('- In classic ASP/VBScript files, '))).toBe(true)
    }
    expect(mixed.content).toContain('Where a SQL Server section applies to classic ASP or VBScript code')

    const vb = await loadPrompt(adapterWith({}), PR, undefined, changed('A.cs', 'B.cs', 'C.vb'))
    expect(vb.content).toContain('- In VB.NET files, do not flag `Async Sub` on event handlers')
    expect(vb.content).toContain('- In VB.NET files, do not flag `Microsoft.VisualBasic` runtime functions')
  })

  it('loads every bundled overlay fragment', async () => {
    const cases: [string, string, string][] = [
      ['A.php', 'use Illuminate\\Http\\Request;', 'php+laravel'],
      ['a.rb', 'class A < ApplicationRecord', 'ruby+rails'],
      ['A.kt', 'import androidx.fragment.app.Fragment', 'kotlin+android'],
      ['A.cs', 'using Microsoft.Data.SqlClient;', 'csharp+sqlserver'],
    ]
    for (const [path, line, source] of cases) {
      const result = await loadPrompt(adapterWith({}), PR, undefined, changed(path), addLines(line))
      expect(result.source).toBe(`stack:${source}`)
      expect(result.content).not.toContain('{{')
    }
  })

  it('repo prompt wins over the stacks', async () => {
    const adapter = adapterWith({ '.agent-review-instructions.md': '## ROLE\nRepo reviewer.' })

    const result = await loadPrompt(adapter, PR, undefined, changed('src/A.java'))

    expect(result.source).toBe('repo')
    expect(result.content).toContain('Repo reviewer.')
    expect(result.content).not.toContain('Senior Backend Architect')
  })

  it('--prompt file wins over the stacks', async () => {
    const adapter = adapterWith({})

    const result = await loadPrompt(adapter, PR, 'prompts/angular-ionic.txt', changed('src/A.java'))

    expect(result.source).toBe('prompts/angular-ionic.txt')
    expect(adapter.getRepoFileContent).not.toHaveBeenCalled()
  })

  it('loads every bundled fragment', async () => {
    const cases: [string[], string][] = [
      [['A.java'], 'java'], [['A.kt'], 'kotlin'], [['a.py'], 'python'],
      [['a.ts'], 'typescript-node'], [['App.tsx'], 'frontend'],
      [['A.cs'], 'csharp'], [['A.vb'], 'vbnet'], [['a.vbs'], 'vbscript'], [['main.go'], 'go'], [['lib.rs'], 'rust'],
      [['a.sh'], 'shell'], [['a.php'], 'php'], [['a.c'], 'cpp'], [['A.swift'], 'swift'],
      [['main.tf'], 'terraform'], [['a.rb'], 'ruby'], [['a.dart'], 'dart'], [['a.ps1'], 'powershell'],
    ]
    for (const [paths, source] of cases) {
      const result = await loadPrompt(adapterWith({}), PR, undefined, changed(...paths))
      expect(result.source).toBe(`stack:${source}`)
      expect(result.content).not.toContain('{{')
    }
  })
})

// PRs with no VB file and no .NET SQL signal must compose exactly these prompts, so the VB/SQL Server rules cannot drift into them
describe('stack prompt byte identity', () => {
  it('composes the recorded prompt for PRs without a VB file or a .NET SQL signal', async () => {
    const nitpicks = config.review.enableNitpicks
    config.review.enableNitpicks = false
    const cases: [string, string[], string][] = [
      ['csharp', ['src/A.cs', 'src/B.cs'], section('src/A.cs', '+var total = items.Sum(i => i.Price);', ' return total;')],
      ['csharp+4 csproj', ['A.cs', 'A.csproj', 'B.csproj', 'C.csproj', 'D.csproj'], section('A.csproj', '+    <PackageReference Include="Serilog" Version="3.1.1" />')],
      ['csharp below floor', ['A.cs', 'A.csproj', 'B.csproj', 'C.csproj', 'D.csproj', 'E.csproj'], ''],
      ['aspnet', ['HomeController.cs'], addLines('using Microsoft.AspNetCore.Mvc;')],
      ['blazor', ['Pages/X.razor', 'App.cs'], ''],
      ['maui', ['MainPage.xaml.cs'], addLines('using Microsoft.Maui.Controls;')],
      ['winforms', ['Form1.Designer.cs', 'Form1.cs'], ''],
      ['wpf', ['MainWindow.xaml', 'MainWindow.xaml.cs'], section('MainWindow.xaml', '+<Window x:Class="App.MainWindow">')],
      ['webforms c#', ['Default.aspx', 'Default.aspx.cs'], ''],
      ['project files only', ['Api.csproj', 'Directory.Packages.props'], ''],
      ['csharp+npgsql', ['A.cs'], addLines('using Npgsql;', 'await using var conn = new NpgsqlConnection(cs);')],
      ['csharp+postgres sql', ['A.cs', 'db/m.sql'], section('db/m.sql', '+CREATE TABLE users (id SERIAL PRIMARY KEY);', '+SELECT id FROM users LIMIT 10;')],
      ['csharp+english', ['A.cs'], addLines('// Select top rated items from the update queue', 'ShowMessage("Please select an item from the list");', '#pragma warning disable CS0618', 'var engine = new Engine();')],
      ['sql only', ['db/001.sql'], section('db/001.sql', '+SELECT TOP 10 * FROM [dbo].[Users]', '+GO')],
      ['python+SqlConnection', ['a.py'], addLines('conn = SqlConnection(cs)')],
      ['typescript', ['src/a.ts'], ''],
      ['java+spring', ['src/A.java'], addLines('import org.springframework.stereotype.Service')],
      ['python', ['app/main.py'], ''],
      ['go', ['cmd/main.go', 'util.go'], ''],
      ['frontend+angular+ionic', ['a.component.ts'], addLines("import { Camera } from '@capacitor/camera'")],
      ['mixed web', ['web/App.tsx', 'web/api.ts', 'web/app.css', 'server/main.py', 'server/db.py'], ''],
      ['default', ['README.md', 'a.scala'], ''],
    ]
    const out: string[] = []
    try {
      for (const [name, paths, diff] of cases) {
        const r = await loadPrompt(adapterWith({}), PR, undefined, changed(...paths), diff)
        out.push(`${name}: ${r.source} ${createHash('sha256').update(r.content).digest('hex')}`)
      }
    } finally { config.review.enableNitpicks = nitpicks }
    expect(out).toMatchInlineSnapshot(`
      [
        "csharp: stack:csharp 75b7d2ababb75b9f663fae2159a269e429832f50f8acdab45116b7a7aadd2347",
        "csharp+4 csproj: stack:csharp 75b7d2ababb75b9f663fae2159a269e429832f50f8acdab45116b7a7aadd2347",
        "csharp below floor: default 7aef3f65400497b41ee2e51191394dbad033ed207a38ad795671e52e3fd616a5",
        "aspnet: stack:csharp+aspnet 1ccabf3f2d4f14fe53e90e6862fb1b1175da607fdb7a558807980892f2fab7bc",
        "blazor: stack:csharp+blazor 09ff4b813378a56edb7485fe5dc7b2fa3a046aa3aa6f9b922d61b1ad93eae2b6",
        "maui: stack:csharp+maui 10311804095d35e87a6db3ba2601e36bf9debc1ffcaf1f314ce8013ac6375965",
        "winforms: stack:csharp+winforms a61ef220c20c0f166e257d5dceefab89af0991580f5e808eeb4da3b56ef47d9b",
        "wpf: stack:csharp+winforms a61ef220c20c0f166e257d5dceefab89af0991580f5e808eeb4da3b56ef47d9b",
        "webforms c#: stack:csharp 75b7d2ababb75b9f663fae2159a269e429832f50f8acdab45116b7a7aadd2347",
        "project files only: default 7aef3f65400497b41ee2e51191394dbad033ed207a38ad795671e52e3fd616a5",
        "csharp+npgsql: stack:csharp 75b7d2ababb75b9f663fae2159a269e429832f50f8acdab45116b7a7aadd2347",
        "csharp+postgres sql: stack:csharp 75b7d2ababb75b9f663fae2159a269e429832f50f8acdab45116b7a7aadd2347",
        "csharp+english: stack:csharp 75b7d2ababb75b9f663fae2159a269e429832f50f8acdab45116b7a7aadd2347",
        "sql only: default 7aef3f65400497b41ee2e51191394dbad033ed207a38ad795671e52e3fd616a5",
        "python+SqlConnection: stack:python 7e563d9cb3c702b8d7aa7fd4d13ce5c36e84f3f0616703452bcfcb9e6a924710",
        "typescript: stack:typescript-node 49bcb0fd3d6a212ddc637869b37ba293b0699e7d525cbf3f44f2020050573bc7",
        "java+spring: stack:java+spring e9b6a8c8363deb1f25a65b8b486405a69a4f4f5f84a914d520f201deafad67cb",
        "python: stack:python 7e563d9cb3c702b8d7aa7fd4d13ce5c36e84f3f0616703452bcfcb9e6a924710",
        "go: stack:go 9a166a25bf63cb0392f8ab42df0c4b2c27bab22de5e572e3bd195a42d3ce0c6d",
        "frontend+angular+ionic: stack:frontend+angular+ionic fefeef632892c2bf45f16ab9ca21fef70a23b4c8a828d4c7d7904bd3256007a4",
        "mixed web: stack:frontend+python 288770e28bdfde855726ef6cbeacec9c7389b33f94e44e72a361306b12c54837",
        "default: default 7aef3f65400497b41ee2e51191394dbad033ed207a38ad795671e52e3fd616a5",
      ]
    `)
  })

  // A C# PR with a .vbs file composes csharp+vbscript; the other three pin the classic ASP prompts
  it('pins the classic ASP and VBScript prompts', async () => {
    const nitpicks = config.review.enableNitpicks
    config.review.enableNitpicks = false
    const query = '+Set rs = conn.Execute("SELECT Id FROM Users WHERE Id = " & id)'
    const cases: [string, string[], string][] = [
      ['csharp+vbs', ['src/A.cs', 'src/B.cs', 'tools/deploy.vbs'], section('tools/deploy.vbs', '+Set sh = CreateObject("WScript.Shell")')],
      ['aspx only', ['Default.aspx'], ''],
      ['asp+access', ['default.asp'], section('default.asp', '+conn.Open "Provider=Microsoft.Jet.OLEDB.4.0;Data Source=" & Server.MapPath("db/app.mdb")', query)],
      ['asp+sqloledb', ['default.asp'], section('default.asp', '+conn.Open "Provider=SQLOLEDB;Data Source=db01;Initial Catalog=App;Integrated Security=SSPI"', query)],
    ]
    const out: string[] = []
    try {
      for (const [name, paths, diff] of cases) {
        const r = await loadPrompt(adapterWith({}), PR, undefined, changed(...paths), diff)
        out.push(`${name}: ${r.source} ${createHash('sha256').update(r.content).digest('hex')}`)
      }
    } finally { config.review.enableNitpicks = nitpicks }
    expect(out).toMatchInlineSnapshot(`
      [
        "csharp+vbs: stack:csharp+vbscript 4745e6c08dbd7d636b1e6ad635755f4fe69a0b6ef302086dbd6545994aa15d57",
        "aspx only: default 7aef3f65400497b41ee2e51191394dbad033ed207a38ad795671e52e3fd616a5",
        "asp+access: stack:vbscript ba169e24b04ba563e58c148bf5b512231155f0cea19437c61da136df4121b8fe",
        "asp+sqloledb: stack:vbscript+sqlserver d3516812941f571b49fac7936875b01d827c1aba4c1b26e53361c20fa0ad6ea7",
      ]
    `)
  })
})
